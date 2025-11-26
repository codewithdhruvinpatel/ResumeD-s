require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const flash = require('connect-flash');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const path = require('path');
const axios = require('axios');
const nodemailer = require('nodemailer');
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'dhruvinpatel2394@gmail.com',
    pass: 'bhlj kytd kkpq btmi'
  }
});
const app = express();
const port = 3000;

// PostgreSQL config
const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'dsoffice',
  password: 'Dhruvin2394@',
  port: 5432,
});

// Middlewares
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: 'resumeSecret',
  resave: false,
  saveUninitialized: false,
}));
app.use(flash());

// Set EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Flash + user data
app.use((req, res, next) => {
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
  res.locals.user = req.session.user;
  next();
});

// Auth checker
function checkAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

// Routes
app.get('/', (req, res) => res.render('pages/home', { title: "Home - D's Resume" }));
app.get('/login', (req, res) => {
  res.render('pages/login', {
    title: 'Login - D’s Resume'
  });
});


app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query('SELECT * FROM clint_users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      req.flash('error', 'No user found');
      return res.redirect('/login');
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      req.flash('error', 'Invalid credentials');
      return res.redirect('/login');
    }

    // Remove password before storing session
    delete user.password;
    req.session.user = user;

    res.redirect('/dashboard');
  } catch (err) {
    console.error('Login error:', err);
    req.flash('error', 'Something went wrong');
    res.redirect('/login');
  }
});



app.get('/register', (req, res) => {
  res.render('pages/register', {
    title: 'Register - D’s Resume'
  });
});
app.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM clint_users WHERE email = $1', [email]);
    if (rows[0]) {
      req.flash('error', 'User already exists.'); return res.redirect('/register');
    }
    const hashed = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO clint_users (name,email,password) VALUES ($1,$2,$3)', [name, email, hashed]);
    req.flash('success', 'Registered successfully. Please log in.');
    res.redirect('/login');
  } catch (err) {
    console.error(err); req.flash('error', 'Error occurred'); res.redirect('/register');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.get('/project/request', checkAuth, (req, res) =>
  res.render('pages/project_request', { title: 'Project Request - D’s Resume' })
);

app.post('/project/request', checkAuth, async (req, res) => {
  const { name, email, mobile, address, state, country, pincode, project_type } = req.body;
  try {
    await pool.query(
      `INSERT INTO project_requests (name,email,mobile,address,state,country,pincode,project_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [name, email, mobile, address, state, country, pincode, project_type]
    );
    req.flash('success', 'Project request submitted.');
    res.redirect('/dashboard');
  } catch (err) {
    console.error(err); req.flash('error', 'Error submitting request.'); res.redirect('/project/request');
  }
});

app.get('/dashboard', checkAuth, async (req, res) => {
  const userEmail = req.session.user.email;

  try {
    const prRes = await pool.query(
      'SELECT * FROM project_requests WHERE email = $1 ORDER BY created_at DESC',
      [userEmail]
    );

    const projects = await Promise.all(prRes.rows.map(async (reqRow) => {
      const [
        statusRes, detailRes, serviceRes, paymentRes, meetingRes
      ] = await Promise.all([
        pool.query('SELECT status FROM project_status WHERE project_id = $1', [reqRow.id]),
        pool.query('SELECT * FROM status_details WHERE project_id = $1', [reqRow.id]),
        pool.query('SELECT * FROM project_services WHERE project_id = $1', [reqRow.id]),
        pool.query('SELECT * FROM project_payments WHERE project_id = $1', [reqRow.id]),
        pool.query('SELECT meeting_date, meeting_time, meeting_mode, status FROM project_meetings WHERE project_id = $1', [reqRow.id]),
      ]);

      return {
        request: reqRow,
        status: statusRes.rows[0],
        details: detailRes.rows[0]
          ? {
              frontend: detailRes.rows[0].frontend_status,
              backend: detailRes.rows[0].backend_status,
              database: detailRes.rows[0].db_status,
              testing: detailRes.rows[0].testing_status
            }
          : {},
        services: serviceRes.rows,
        payments: paymentRes.rows,
        meetings: meetingRes.rows,
      };
    }));

    res.render('dashboard/index', {
      title: 'Dashboard - D’s Resume',
      projects
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Error loading dashboard');
    res.redirect('/');
  }
});

// Forget password page
app.get('/forgot-password', (req, res) => {
  res.render('pages/forgot-password', { title: 'Forgot Password', error: req.flash('error'), success: req.flash('success') });
});

// POST to send OTP
app.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  const otp = Math.floor(100000 + Math.random() * 900000);

  try {
    const userRes = await pool.query('SELECT * FROM clint_users WHERE email = $1', [email]);
    if (userRes.rows.length === 0) {
      req.flash('error', 'Email not found.');
      return res.redirect('/forgot-password');
    }

    await pool.query('UPDATE clint_users SET otp = $1 WHERE email = $2', [otp, email]);

    await transporter.sendMail({
      from: `"D's Office" <dhruvinpatel2394@gmail.com>`,
      to: email,
      subject: '🔐 Password Reset OTP - D’s Office',
      html: `
        <h2>Your OTP Code</h2>
        <p>Use this code to reset your password:</p>
        <h3>${otp}</h3>
        <p>This code is valid for a short time. Do not share it.</p>
      `
    });

    req.flash('success', 'OTP sent to your email.');
    res.render('pages/reset-password', { title: 'Reset Password', email, success: req.flash('success'), error: req.flash('error') });
  } catch (err) {
    console.error('Error sending OTP:', err);
    req.flash('error', 'Something went wrong.');
    res.redirect('/forgot-password');
  }
});

// Reset password page (POST)
app.post('/reset-password', async (req, res) => {
  const { email, otp, new_password } = req.body;

  try {
    const result = await pool.query('SELECT * FROM clint_users WHERE email = $1 AND otp = $2', [email, otp]);
    if (result.rows.length === 0) {
      req.flash('error', 'Invalid OTP or email.');
      return res.render('pages/reset-password', { title: 'Reset Password', email, error: req.flash('error'), success: '' });
    }

    const hashed = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE clint_users SET password = $1, otp = NULL WHERE email = $2', [hashed, email]);

    req.flash('success', 'Password updated. You can now login.');
    res.redirect('/login');
  } catch (err) {
    console.error('Password reset failed:', err);
    req.flash('error', 'Something went wrong.');
    res.render('pages/reset-password', { title: 'Reset Password', email, error: req.flash('error'), success: '' });
  }
});

// Nodemailer Transport (using hardcoded for now)


// Project Request POST
app.post('/project/request', async (req, res) => {
  const { name, email, mobile, address, state, country, pincode, project_type } = req.body;

  
  try {
    // 1. Save project request with OTP to DB
    await pool.query(
      `INSERT INTO project_requests 
       (name, email, mobile, address, state, country, pincode, project_type, otp, status) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')`,
      [name, email, mobile, address, state, country, pincode, project_type, otp]
      
    );
    console.log('Project request saved with OTP:', { name, email, mobile, address, state, country, pincode, project_type, otp });



    // 3. Show success message and go to OTP verify section
    req.flash('success', 'Project request submitted! An OTP has been sent to your email.');
    res.redirect('/project/verify'); // ✅ redirect to OTP verify page

  } catch (err) {
    console.error('❌ Error during project request:', err);
    req.flash('error', 'Something went wrong. Please try again.');
    res.redirect('/project/requ;est')
  }
});

app.get('/project/policy', (req, res) => {
  res.render('pages/policies.ejs', { title: 'Project Policies' });
});






// Start server
app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
