// index.js
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const flash = require('connect-flash');
const bodyParser = require('body-parser');
const path = require('path');
const nodemailer = require('nodemailer');
const http = require('http');

// Neon DB client
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

const app = express();
const port = process.env.PORT || 3000;

// Nodemailer (use env vars; do NOT commit credentials)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || 'dhruvinpatel2394@gmail.com',
    pass: process.env.EMAIL_PASS || 'your-app-password'
  }
});

// Middlewares
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'resumeSecret',
  resave: false,
  saveUninitialized: false,
}));
app.use(flash());

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Flash + user data available in all views
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

/* ---------- Routes ---------- */

// simple health / version route for testing Neon
app.get('/db-version', async (req, res) => {
  try {
    const result = await sql`SELECT version()`;
    const { version } = result[0] || {};
    res.type('text').send(version || 'unknown');
  } catch (err) {
    console.error('DB version check failed:', err);
    res.status(500).send('DB error');
  }
});

app.get('/', (req, res) => res.render('pages/home', { title: "Home - D's Resume" }));

app.get('/login', (req, res) => {
  res.render('pages/login', { title: "Login - D's Resume" });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const rows = await sql`SELECT * FROM clint_users WHERE email = ${email}`;
    if (!rows || rows.length === 0) {
      req.flash('error', 'No user found');
      return res.redirect('/login');
    }

    const user = rows[0];
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      req.flash('error', 'Invalid credentials');
      return res.redirect('/login');
    }

    // Remove sensitive fields before storing session
    const safeUser = { ...user };
    delete safeUser.password;
    delete safeUser.otp;
    req.session.user = safeUser;

    res.redirect('/dashboard');
  } catch (err) {
    console.error('Login error:', err);
    req.flash('error', 'Something went wrong');
    res.redirect('/login');
  }
});

app.get('/register', (req, res) => {
  res.render('pages/register', { title: "Register - D's Resume" });
});

app.post('/register', async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    req.flash('error', 'All fields are required.');
    return res.redirect('/register');
  }
  if (password.length < 6) {
    req.flash('error', 'Password must be at least 6 characters.');
    return res.redirect('/register');
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    req.flash('error', 'Enter a valid email address.');
    return res.redirect('/register');
  }

  try {
    const existing = await sql`SELECT id FROM clint_users WHERE email = ${email.toLowerCase().trim()}`;
    if (existing && existing.length > 0) {
      req.flash('error', 'User already exists. Please login or use another email.');
      return res.redirect('/register');
    }

    const hashed = await bcrypt.hash(password, 10);
    await sql`
      INSERT INTO clint_users (name, email, password, created_at)
      VALUES (${name.trim()}, ${email.toLowerCase().trim()}, ${hashed}, NOW())
    `;

    req.flash('success', 'Registered successfully. Please log in.');
    res.redirect('/login');
  } catch (err) {
    console.error('Register error:', err);
    req.flash('error', 'Something went wrong. Please try again later.');
    res.redirect('/register');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    // ignore error and redirect
    res.redirect('/');
  });
});

app.get('/project/request', checkAuth, (req, res) => {
  res.render('pages/project_request', { title: "Project Request - D's Resume" });
});

// single POST handler for project request (fixed:
// - generate otp
// - insert using neon sql
// - send email
app.post('/project/request', checkAuth, async (req, res) => {
  const { name, email, mobile, address, state, country, pincode, project_type } = req.body;
  const otp = Math.floor(100000 + Math.random() * 900000);

  try {
    await sql`
      INSERT INTO project_requests
      (name, email, mobile, address, state, country, pincode, project_type, otp, status, created_at)
      VALUES
      (${name}, ${email}, ${mobile}, ${address}, ${state}, ${country}, ${pincode}, ${project_type}, ${otp}, 'pending', NOW())
    `;

    // send OTP email to requester
    await transporter.sendMail({
      from: `"D's Office" <${process.env.EMAIL_USER || 'dhruvinpatel2394@gmail.com'}>`,
      to: email,
      subject: '🔐 Project Request OTP - D’s Office',
      html: `<h3>Your OTP for the project request is:</h3><h2>${otp}</h2><p>Keep this secure.</p>`
    });

    req.flash('success', 'Project request submitted! An OTP has been sent to your email.');
    res.redirect('/project/verify');
  } catch (err) {
    console.error('Error during project request:', err);
    req.flash('error', 'Something went wrong. Please try again.');
    res.redirect('/project/request');
  }
});

app.get('/project/verify', checkAuth, (req, res) => {
  res.render('pages/project_verify', { title: "Verify Project - D's Resume" });
});

app.get('/dashboard', checkAuth, async (req, res) => {
  try {
    const userEmail = req.session.user.email;
    const prRows = await sql`SELECT * FROM project_requests WHERE email = ${userEmail} ORDER BY created_at DESC`;

    // for each request, fetch related tables
    const projects = await Promise.all(prRows.map(async (reqRow) => {
      const statusRes = await sql`SELECT status FROM project_status WHERE project_id = ${reqRow.id}`;
      const detailRes = await sql`SELECT * FROM status_details WHERE project_id = ${reqRow.id}`;
      const serviceRes = await sql`SELECT * FROM project_services WHERE project_id = ${reqRow.id}`;
      const paymentRes = await sql`SELECT * FROM project_payments WHERE project_id = ${reqRow.id}`;
      const meetingRes = await sql`SELECT meeting_date, meeting_time, meeting_mode, status FROM project_meetings WHERE project_id = ${reqRow.id}`;

      return {
        request: reqRow,
        status: statusRes && statusRes[0] ? statusRes[0] : {},
        details: detailRes && detailRes[0] ? {
          frontend: detailRes[0].frontend_status,
          backend: detailRes[0].backend_status,
          database: detailRes[0].db_status,
          testing: detailRes[0].testing_status
        } : {},
        services: serviceRes || [],
        payments: paymentRes || [],
        meetings: meetingRes || []
      };
    }));

    res.render('dashboard/index', { title: "Dashboard - D's Resume", projects });
  } catch (err) {
    console.error('Error loading dashboard:', err);
    req.flash('error', 'Error loading dashboard');
    res.redirect('/');
  }
});

// Forgot password -> send OTP
app.get('/forgot-password', (req, res) => {
  res.render('pages/forgot-password', { title: 'Forgot Password', error: req.flash('error'), success: req.flash('success') });
});

app.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  const otp = Math.floor(100000 + Math.random() * 900000);

  try {
    const userRes = await sql`SELECT * FROM clint_users WHERE email = ${email}`;
    if (!userRes || userRes.length === 0) {
      req.flash('error', 'Email not found.');
      return res.redirect('/forgot-password');
    }

    await sql`UPDATE clint_users SET otp = ${otp} WHERE email = ${email}`;

    await transporter.sendMail({
      from: `"D's Office" <${process.env.EMAIL_USER || 'dhruvinpatel2394@gmail.com'}>`,
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

// Reset password endpoint
app.post('/reset-password', async (req, res) => {
  const { email, otp, new_password } = req.body;

  try {
    const result = await sql`SELECT * FROM clint_users WHERE email = ${email} AND otp = ${otp}`;
    if (!result || result.length === 0) {
      req.flash('error', 'Invalid OTP or email.');
      return res.render('pages/reset-password', { title: 'Reset Password', email, error: req.flash('error'), success: '' });
    }

    const hashed = await bcrypt.hash(new_password, 10);
    await sql`UPDATE clint_users SET password = ${hashed}, otp = NULL WHERE email = ${email}`;

    req.flash('success', 'Password updated. You can now login.');
    res.redirect('/login');
  } catch (err) {
    console.error('Password reset failed:', err);
    req.flash('error', 'Something went wrong.');
    res.render('pages/reset-password', { title: 'Reset Password', email, error: req.flash('error'), success: '' });
  }
});

app.get('/project/policy', (req, res) => {
  res.render('pages/policies.ejs', { title: 'Project Policies' });
});

// Start server (http for compatibility; using express.listen is fine too)
http.createServer(app).listen(port, () => console.log(`Server running at http://localhost:${port}`));
