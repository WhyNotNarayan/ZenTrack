require('dotenv').config(); // ✅ .env support

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

// Auth page (combined login/signup)
app.get('/auth', (req, res) => {
  res.render('auth', { error: req.session.messages ? req.session.messages[0] : null });
});

// Signup
app.post('/signup', async (req, res) => {
  try {
    const { email, username, password, mobile } = req.body;
    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) return res.redirect('/auth?error=Email or username already exists');
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ email, username, password: hashedPassword, mobile });
    await newUser.save();
    res.redirect('/auth');
  } catch (err) {
    res.redirect('/auth?error=Signup failed');
  }
});

// Login
app.post('/login', passport.authenticate('local', {
  successRedirect: '/',
  failureRedirect: '/auth',
  failureMessage: true
}));

// Update passport to use email
passport.use(new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
  try {
    const user = await User.findOne({ email });
    if (!user) return done(null, false, { message: 'Incorrect email' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return done(null, false, { message: 'Incorrect password' });
    return done(null, user);
  } catch (err) { return done(err); }
}));

// Redirect old /login and /signup to /auth
app.get('/login', (req, res) => res.redirect('/auth'));
app.get('/signup', (req, res) => res.redirect('/auth'));

// Logout
app.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    res.redirect('/login');
  });
});

// Theme middleware (only once)
app.use((req, res, next) => {
  if (req.session) {
    req.session.theme = req.session.theme || 'light';
  }
  next();
});

// Toggle theme
app.get('/toggle-theme', isAuthenticated, (req, res) => {
  if (req.session) {
    req.session.theme = req.session.theme === 'light' ? 'dark' : 'light';
  }
  res.redirect(req.headers.referer || '/');
});

// Home route
app.get('/', isAuthenticated, async (req, res) => {
  const today = moment().startOf('day').toDate();
  const goals = await Goal.find({ user: req.user._id });
  const tracks = await DailyTrack.find({ user: req.user._id });

  // Monthly data
  const currentMonth = moment().startOf('month');
  const monthEnd = moment().endOf('month');
  const dates = [];
  for (let d = currentMonth.clone(); d.isSameOrBefore(monthEnd, 'day'); d.add(1, 'day')) {
    dates.push(d.toDate());
  }

  // Completion % for circle chart
  const totalPossible = goals.length * dates.length;
  const completed = tracks.filter(t => t.completed).length;
  const progress = totalPossible > 0 ? (completed / totalPossible) * 100 : 0;

  const isPast = (date) => moment(date).isBefore(moment().startOf('day'));

  await initDailyTracks(today, req.user._id);
  res.render('tracker', {
    goals,
    tracks,
    date: today,
    moment,
    isPast,
    user: req.user,
    theme: req.session.theme,
    currentMonth: currentMonth.format('MMMM YYYY'),
    dates,
    progress: JSON.stringify(progress)
  });
});

// ... keep all your existing requires and setup above

// Manage Goals page
app.get('/goals', isAuthenticated, async (req, res) => {
  const goals = await Goal.find({ user: req.user._id });
  res.render('goals', { goals, user: req.user, theme: req.session.theme });
});

// Add a new goal
app.post('/goals', isAuthenticated, async (req, res) => {
  const { name, time } = req.body;
  await new Goal({ name, time, user: req.user._id }).save();
  res.redirect('/goals');
});

// POST /tracker
app.post('/goals', isAuthenticated, async (req, res) => {
  const { name, time } = req.body;
  await new Goal({ name, time, user: req.user._id }).save();
  res.redirect('/goals');
});

app.post('/goals/delete/:id', isAuthenticated, async (req, res) => {
  try {
    const goalId = req.params.id;
    await Goal.findByIdAndDelete(goalId);
    res.redirect('/goals');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error deleting goal');
  }
});

// Server listen
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`ZenTrack running on port ${port}`));