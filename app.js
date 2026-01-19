require('dotenv').config(); // ✅ Add this at the very top for .env support

const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const moment = require('moment');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcryptjs');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const Goal = require('./models/Goal');
const DailyTrack = require('./models/DailyTrack');
const User = require('./models/User');

const app = express();
app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('DB Connected'))
  .catch(err => console.log(err));

  
// Session config
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGO_URI })
}));

// Passport config
app.use(passport.initialize());
app.use(passport.session());

passport.use(new LocalStrategy(async (username, password, done) => {
  try {
    const user = await User.findOne({ username });
    if (!user) return done(null, false, { message: 'Incorrect username' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return done(null, false, { message: 'Incorrect password' });
    return done(null, user);
  } catch (err) { return done(err); }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) { done(err); }
});

// Middleware to check authentication
function isAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}

// Init daily tracks function
async function initDailyTracks(date, userId) {
  const goals = await Goal.find({ user: userId });
  for (let goal of goals) {
    const exists = await DailyTrack.findOne({ date, goal: goal._id, user: userId });
    if (!exists) {
      await new DailyTrack({ date, goal: goal._id, user: userId }).save();
    }
  }
}

// Signup
app.get('/signup', (req, res) => {
  res.render('signup', { error: req.query.error });
});

app.post('/signup', async (req, res) => {
  try {
    const { username, password } = req.body;
    const existingUser = await User.findOne({ username });
    if (existingUser) return res.redirect('/signup?error=Username already exists');
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ username, password: hashedPassword });
    await newUser.save();
    res.redirect('/login');
  } catch (err) {
    res.redirect('/signup?error=Signup failed');
  }
});

// Login
app.get('/login', (req, res) => {
  res.render('login', { error: req.session.messages ? req.session.messages[0] : null });
});

app.post('/login', passport.authenticate('local', {
  successRedirect: '/',
  failureRedirect: '/login',
  failureMessage: true
}));

// Logout
app.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    res.redirect('/login');
  });
});

// Home/Tracker
app.get('/', isAuthenticated, async (req, res) => {
  const today = moment().startOf('day').toDate();
  const goals = await Goal.find({ user: req.user._id });
  const tracks = await DailyTrack.find({ date: today, user: req.user._id });
  const isPast = moment(today).isBefore(moment().startOf('day'));
  await initDailyTracks(today, req.user._id);
  res.render('tracker', { goals, tracks, date: today, moment, isPast });
});

// Goals
app.get('/goals', isAuthenticated, async (req, res) => {
  const goals = await Goal.find({ user: req.user._id });
  res.render('goals', { goals });
});

app.post('/goals', isAuthenticated, async (req, res) => {
  const { name, time } = req.body;
  const newGoal = new Goal({ name, time, user: req.user._id });
  await newGoal.save();
  res.redirect('/goals');
});

// Update Tracker
app.post('/tracker', isAuthenticated, async (req, res) => {
  const today = moment().startOf('day').toDate();
  if (moment(today).isBefore(moment().startOf('day'))) return res.redirect('/');
  const { goalId, completed } = req.body;
  await DailyTrack.findOneAndUpdate(
    { date: today, goal: goalId, user: req.user._id },
    { completed: completed === 'on' },
    { upsert: true }
  );
  res.redirect('/');
});

// Analytics
app.get('/analytics', isAuthenticated, async (req, res) => {
  const goals = await Goal.find({ user: req.user._id });
  const tracks = await DailyTrack.aggregate([
    { $match: { user: req.user._id } },
    { $group: { _id: { date: { $dateToString: { format: '%Y-%m-%d', date: '$date' } }, goal: '$goal' }, completed: { $sum: { $cond: ['$completed', 1, 0] } } } }
  ]);
  const dates = [...new Set(tracks.map(t => t._id.date))].sort();
  const data = goals.map(goal => ({
    label: goal.name,
    data: dates.map(date => tracks.find(t => t._id.date === date && t._id.goal.toString() === goal._id.toString())?.completed || 0)
  }));
  res.render('analytics', { dates: JSON.stringify(dates), data: JSON.stringify(data) });
});

// Server listen
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`ZenTrack running on port ${port}`));