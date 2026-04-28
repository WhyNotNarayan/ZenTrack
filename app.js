require('dotenv').config();

const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const moment = require('moment');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcryptjs');
const session = require('express-session');
const MongoStore = require('connect-mongo');

// Models
const Goal = require('./models/Goal');
const DailyTrack = require('./models/DailyTrack');
const User = require('./models/User');
const PushSubscription = require('./models/PushSubscription');

// Prevent crashes on Vercel
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});


const app = express();
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('DATABASE CONNECTED'))
  .catch(err => console.error('MONGODB ERROR:', err.message));

// Session config
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGO_URI || 'mongodb://localhost:27017/zentrack'
  })
}));

// Passport config
app.use(passport.initialize());
app.use(passport.session());

passport.use(new LocalStrategy({
  usernameField: 'email',
  passwordField: 'password'
}, async (email, password, done) => {
  try {
    const user = await User.findOne({ email });
    if (!user) return done(null, false, { message: 'Incorrect email' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return done(null, false, { message: 'Incorrect password' });
    return done(null, user);
  } catch (err) {
    return done(err);
  }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) { done(err); }
});

function isAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/auth');
}

// Auth page
app.get('/auth', (req, res) => {
  res.render('auth', {
    error: req.session.messages ? req.session.messages[0] : null
  });
});

// Signup
app.post('/signup', async (req, res) => {
  try {
    const { email, username, password, mobile } = req.body;
    if (!mobile || typeof mobile !== 'string') {
      return res.redirect('/auth?error=Mobile number is required');
    }
    const cleanedMobile = mobile.replace(/\D/g, '');
    if (cleanedMobile.length !== 10) {
      return res.redirect('/auth?error=Mobile number must be exactly 10 digits');
    }
    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      return res.redirect('/auth?signup=1&error=Email or username already exists');
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ email, username, password: hashedPassword, mobile: cleanedMobile });
    await newUser.save();
    res.redirect('/auth?success=Account%20created%20successfully!%20Please%20login%20now.');
  } catch (err) {
    console.error('Signup error:', err);
    res.redirect('/auth?signup=1&error=Something went wrong. Please try again.');
  }
});

// Login
app.post('/login', passport.authenticate('local', {
  successRedirect: '/',
  failureRedirect: '/auth',
  failureMessage: true
}));

app.get('/login', (req, res) => res.redirect('/auth'));
app.get('/signup', (req, res) => res.redirect('/auth'));

// Logout
app.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    res.redirect('/auth');
  });
});

// Theme middleware
app.use((req, res, next) => {
  if (req.session) req.session.theme = req.session.theme || 'light';
  next();
});

app.get('/toggle-theme', isAuthenticated, (req, res) => {
  if (req.session) req.session.theme = req.session.theme === 'light' ? 'dark' : 'light';
  res.redirect(req.headers.referer || '/');
});

// Home route
app.get('/', isAuthenticated, async (req, res) => {
  const today = moment().startOf('day').toDate();
  const currentMonth = moment().startOf('month');
  const monthEnd = moment().endOf('month');

  const goals = await Goal.find({ user: req.user._id });
  const tracks = await DailyTrack.find({
    user: req.user._id,
    date: { $gte: currentMonth.toDate(), $lte: monthEnd.toDate() }
  });

  const dates = [];
  for (let d = currentMonth.clone(); d.isSameOrBefore(monthEnd, 'day'); d.add(1, 'day')) {
    dates.push(d.toDate());
  }

  const totalPossible = goals.length * dates.length;
  const completed = tracks.filter(t => t.completed).length;
  const progress = totalPossible > 0 ? (completed / totalPossible) * 100 : 0;
  const isPast = (date) => moment(date).isBefore(moment().startOf('day'));

  const data = [{
    label: 'Goal Completion',
    data: dates.map(date => {
      const tracksForDate = tracks.filter(t => moment(t.date).isSame(date, 'day'));
      return tracksForDate.filter(t => t.completed).length;
    }),
    borderColor: '#6366f1',
    backgroundColor: 'rgba(99, 102, 241, 0.2)',
    fill: true
  }];

  const showGuide = req.user.isFirstLogin !== false;

  res.render('tracker', {
    goals, tracks, date: today, moment, isPast,
    user: req.user, theme: req.session.theme,
    currentMonth: currentMonth.format('MMMM YYYY'),
    dates, progress: JSON.stringify(progress), data, showGuide
  });
});

// Mark guide as done when user dismisses it
app.post('/guide-done', isAuthenticated, async (req, res) => {
  try {
    await req.user.updateOne({ isFirstLogin: false });
  } catch (e) { console.error(e); }
  res.json({ ok: true });
});

// Goals page
app.get('/goals', isAuthenticated, async (req, res) => {
  const goals = await Goal.find({ user: req.user._id });
  res.render('goals', { goals, user: req.user, theme: req.session.theme });
});

app.post('/goals', isAuthenticated, async (req, res) => {
  const { name, time } = req.body;
  const goal = await new Goal({ name, time, user: req.user._id }).save();
  if (req.xhr || req.headers.accept.indexOf('json') > -1) return res.json({ success: true, goal });
  res.redirect('/goals');
});

app.post('/goals/delete/:id', isAuthenticated, async (req, res) => {
  try {
    const goalId = req.params.id;
    await Goal.findByIdAndDelete(goalId);
    if (req.xhr || req.headers.accept.indexOf('json') > -1) return res.json({ success: true, id: goalId });
    res.redirect('/goals');
  } catch (err) {
    console.error(err);
    if (req.xhr || req.headers.accept.indexOf('json') > -1) return res.status(500).json({ error: 'Error deleting goal' });
    res.status(500).send('Error deleting goal');
  }
});

app.get('/goals/edit/:id', isAuthenticated, async (req, res) => {
  try {
    const goal = await Goal.findById(req.params.id);
    if (!goal) return res.status(404).send('Goal not found');
    res.render('editgoal', { goal, user: req.user, theme: req.session.theme });
  } catch (err) {
    res.status(500).send('Error retrieving goal');
  }
});

app.post('/goals/edit/:id', isAuthenticated, async (req, res) => {
  try {
    const { name, time } = req.body;
    await Goal.findByIdAndUpdate(req.params.id, { name, time });
    res.redirect('/goals');
  } catch (err) {
    res.status(500).send('Error updating goal');
  }
});

// Tracker checkbox
app.post('/tracker', isAuthenticated, async (req, res) => {
  const { date: selectedDate, goalId, completed } = req.body;
  const trackDate = moment(selectedDate || moment().format('YYYY-MM-DD')).startOf('day').toDate();
  if (moment(trackDate).isBefore(moment().subtract(1, 'day').startOf('day'))) return res.redirect('/');
  await DailyTrack.findOneAndUpdate(
    { date: trackDate, goal: goalId, user: req.user._id },
    { completed: completed === 'on' || completed === true },
    { upsert: true }
  );
  if (req.xhr || req.headers.accept.indexOf('json') > -1) return res.json({ success: true });
  res.redirect('/');
});

// Analytics
app.get('/analytics', isAuthenticated, async (req, res) => {
  const goals = await Goal.find({ user: req.user._id });
  const tracks = await DailyTrack.find({ user: req.user._id });
  const dates = [...new Set(tracks.map(t => moment(t.date).format('YYYY-MM-DD')))].sort();
  const dataValues = dates.map(date => {
    const tracksForDate = tracks.filter(t => moment(t.date).format('YYYY-MM-DD') === date);
    const completedForDate = tracksForDate.filter(t => t.completed).length;
    return goals.length > 0 ? (completedForDate / goals.length * 100).toFixed(2) : 0;
  });
  const completedCount = tracks.filter(t => t.completed).length;
  const notCompletedCount = tracks.length - completedCount;
  res.render('analytics', {
    dates: JSON.stringify(dates), dataValues: JSON.stringify(dataValues),
    completedCount, notCompletedCount, user: req.user, theme: req.session.theme
  });
});

// History
app.get('/history', isAuthenticated, async (req, res) => {
  const selectedMonth = req.query.month || moment().format('YYYY-MM');
  const monthStart = moment(selectedMonth, 'YYYY-MM').startOf('month');
  const monthEnd = moment(selectedMonth, 'YYYY-MM').endOf('month');
  const goals = await Goal.find({ user: req.user._id });
  const tracks = await DailyTrack.find({
    user: req.user._id,
    date: { $gte: monthStart.toDate(), $lte: monthEnd.toDate() }
  });
  const dates = [];
  for (let d = monthStart.clone(); d.isSameOrBefore(monthEnd, 'day'); d.add(1, 'day')) {
    dates.push(d.toDate());
  }
  const isPast = (date) => moment(date).isBefore(moment().startOf('day'));
  res.render('history', {
    goals, tracks, moment, isPast, user: req.user,
    theme: req.session.theme, selectedMonth,
    displayMonth: monthStart.format('MMMM YYYY'), dates
  });
});

// Google auth
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID || 'dummy');
app.post('/auth/google', async (req, res) => {
  const { idToken } = req.body;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { email, name, picture, sub: googleId } = payload;
    let user = await User.findOne({ email });
    if (!user) {
      user = new User({
        email,
        username: name?.replace(/\s+/g, '').toLowerCase() || email.split('@')[0],
        password: 'google-auth-no-password',
        mobile: '',
        isFirstLogin: true,
        googleId,
        profilePic: picture
      });
      await user.save();
    }
    req.login(user, (err) => {
      if (err) return res.status(500).json({ success: false });
      res.json({ success: true, redirectUrl: '/' });
    });
  } catch (error) {
    console.error('Google auth error:', error);
    res.status(401).json({ success: false, error: 'Invalid token' });
  }
});

// Web Push
const webpush = require('web-push');
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:zentrack@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

async function sendNotification(title, body) {
  try {
    const allSubs = await PushSubscription.find({}).lean();
    for (const doc of allSubs) {
      try {
        await webpush.sendNotification(doc.subscription, JSON.stringify({ title, body }));
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await PushSubscription.deleteOne({ _id: doc._id });
        }
      }
    }
  } catch (err) {
    console.error('PUSH ERROR:', err);
  }
}

if (!process.env.VERCEL) {
  const cron = require('node-cron');
  cron.schedule('0 7 * * *', () => sendNotification('ZenTrack Reminder', 'Good morning! Mark your goals today.'), { timezone: 'Asia/Kolkata' });
  cron.schedule('0 22 * * *', () => sendNotification('ZenTrack Reminder', "Day's ending — check your progress."), { timezone: 'Asia/Kolkata' });
}

app.post('/subscribe', isAuthenticated, async (req, res) => {
  try {
    const subscription = req.body;
    if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
    await PushSubscription.findOneAndUpdate(
      { user: req.user._id },
      { subscription, createdAt: new Date() },
      { upsert: true, new: true }
    );
    res.status(201).json({ success: true });
  } catch (err) {
    console.error('Subscribe error:', err);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

// Export for Vercel
module.exports = app;

// Local server (NOT on Vercel)
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}
