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
const PushSubscription = require('./models/PushSubscription');

const app = express();
app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json()); // ← Added: needed for /subscribe JSON payload
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
// Signup
app.post('/signup', async (req, res) => {
  try {
    const { email, username, password, mobile } = req.body;

    // ─── Mobile number validation ─────────────────────────────────────────────
    if (!mobile || typeof mobile !== 'string') {
      return res.redirect('/auth?error=Mobile number is required');
    }

    // Remove everything that is not a digit (spaces, -, +, etc.)
    const cleanedMobile = mobile.replace(/\D/g, '');

    // Must be EXACTLY 10 digits
    if (cleanedMobile.length !== 10) {
      return res.redirect('/auth?error=Mobile number must be exactly 10 digits (no more, no less)');
    }

    // Optional: Check if it starts with valid Indian mobile prefix (6,7,8,9)
    // if (!['6','7','8','9'].includes(cleanedMobile[0])) {
    //   return res.redirect('/auth?error=Please enter a valid 10-digit Indian mobile number');
    // }

    // ──────────────────────────────────────────────────────────────────────────

    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      return res.redirect('/auth?error=Email or username already exists');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ 
      email, 
      username, 
      password: hashedPassword, 
      mobile: cleanedMobile   // save only digits, cleaned version
    });

    await newUser.save();

    // Optional: success message
    res.redirect('/auth?success=Account created successfully! Please login now.');
  } catch (err) {
    console.error('Signup error:', err);
    res.redirect('/auth?error=Something went wrong. Please try again.');
  }
});

// Login
app.post('/login', passport.authenticate('local', {
  successRedirect: '/',
  failureRedirect: '/auth',
  failureMessage: true
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

  const data = [
    {
      label: 'Goal Completion',
      data: dates.map(date => {
        const tracksForDate = tracks.filter(t => moment(t.date).isSame(date, 'day'));
        const completedTracks = tracksForDate.filter(t => t.completed).length;
        return completedTracks;
      }),
      borderColor: '#6366f1',
      backgroundColor: 'rgba(99, 102, 241, 0.2)',
      fill: true
    }
  ];

  // ─── FIXED & SAFE GUIDE LOGIC ────────────────────────────────────────────
  const showGuide = req.user.isFirstLogin !== false;

  if (showGuide) {
    console.log(`[Guide] Showing tour for ${req.user.email || req.user.username} — isFirstLogin was: ${req.user.isFirstLogin}`);
    
    req.user.isFirstLogin = false;
    await req.user.save();
    
    console.log(`[Guide] isFirstLogin updated to false`);
  } else {
    console.log(`[Guide] Skipped — isFirstLogin = ${req.user.isFirstLogin}`);
  }
  // ──────────────────────────────────────────────────────────────────────────

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
    progress: JSON.stringify(progress),
    data,
    showGuide
  });
});

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

// Route to render the edit goal page
app.get('/goals/edit/:id', isAuthenticated, async (req, res) => {
  try {
    const goalId = req.params.id;
    const goal = await Goal.findById(goalId);
    if (!goal) {
      return res.status(404).send('Goal not found');
    }
    res.render('editgoal', { goal, user: req.user, theme: req.session.theme });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error retrieving goal');
  }
});

// Route to handle the edit goal form submission
app.post('/goals/edit/:id', isAuthenticated, async (req, res) => {
  try {
    const goalId = req.params.id;
    const { name, time } = req.body;
    await Goal.findByIdAndUpdate(goalId, { name, time });
    res.redirect('/goals');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error updating goal');
  }
});

//checkbox post/tracker
app.post('/tracker', isAuthenticated, async (req, res) => {
  const { date: selectedDate, goalId, completed } = req.body;
  const trackDate = moment(selectedDate || moment().format('YYYY-MM-DD')).startOf('day').toDate();

  // Allow saving for today and the past day
  if (moment(trackDate).isBefore(moment().subtract(1, 'day').startOf('day'))) {
    return res.redirect('/');
  }

  await DailyTrack.findOneAndUpdate(
    { date: trackDate, goal: goalId, user: req.user._id },
    { completed: completed === 'on' },
    { upsert: true }
  );

  res.redirect('/');
});

// Analytics route
app.get('/analytics', isAuthenticated, async (req, res) => {
  const goals = await Goal.find({ user: req.user._id });
  const tracks = await DailyTrack.find({ user: req.user._id });

  // Get unique dates from tracks
  const dates = [...new Set(tracks.map(t => moment(t.date).format('YYYY-MM-DD')))].sort();

  // Calculate % completion per day (for line and bar - growth)
  const dataValues = dates.map(date => {
    const tracksForDate = tracks.filter(t => moment(t.date).format('YYYY-MM-DD') === date);
    const completedForDate = tracksForDate.filter(t => t.completed).length;
    const percent = goals.length > 0 ? (completedForDate / goals.length * 100) : 0;
    return percent.toFixed(2); // % per day
  });

  // Overall completed and not completed (for pie)
  const completedCount = tracks.filter(t => t.completed).length;
  const notCompletedCount = tracks.length - completedCount;

  res.render('analytics', {
    dates: JSON.stringify(dates),
    dataValues: JSON.stringify(dataValues),
    completedCount,
    notCompletedCount
  });
});

app.post('/auth/google', async (req, res) => {
  const { idToken } = req.body;

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const { email, name, picture, sub: googleId } = decodedToken;

    let user = await User.findOne({ email });

    if (!user) {
      user = new User({
        email,
        username: name?.replace(/\s+/g, '').toLowerCase() || email.split('@')[0],
        password: 'google-auth-no-password',
        mobile: '', // can ask later or skip
        isFirstLogin: true,
        googleId,
        profilePic: picture
      });
      await user.save();
    }

    // Login with Passport (manual)
    req.login(user, (err) => {
      if (err) return res.status(500).json({ success: false });
      res.json({ success: true });
    });
  } catch (error) {
    console.error('Google auth error:', error);
    res.status(401).json({ success: false, error: 'Invalid token' });
  }
});

// Web Push Notifications
const webpush = require('web-push');
const cron = require('node-cron');

webpush.setVapidDetails(
  'mailto:your-email@example.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ─── Send notification to all valid subscriptions from DB ──────────────────────
async function sendNotification(title, body) {
  try {
    const allSubs = await PushSubscription.find({}).lean();

    if (allSubs.length === 0) {
      console.log('[PUSH] No subscriptions found in database');
      return;
    }

    console.log(`[PUSH] Attempting to send "${title}" to ${allSubs.length} subscriptions`);

    for (const doc of allSubs) {
      const sub = doc.subscription;
      try {
        await webpush.sendNotification(
          sub,
          JSON.stringify({ title, body })
        );
        console.log(`[PUSH] Successfully sent "${title}" to user ${doc.user}`);
      } catch (err) {
        console.error(`[PUSH] Failed to send to user ${doc.user}:`, err.message || err);
        
        // Clean up invalid/expired subscriptions
        if (err.statusCode === 410 || err.statusCode === 404) {
          await PushSubscription.deleteOne({ _id: doc._id });
          console.log(`[PUSH] Removed expired/gone subscription for user ${doc.user}`);
        }
      }
    }
  } catch (err) {
    console.error('[PUSH] Error fetching or sending notifications:', err);
  }
}

// Morning reminder at 7:00 AM IST
cron.schedule('0 7 * * *', () => {
  console.log('[CRON] Running morning reminder at 7 AM IST');
  sendNotification("ZenTrack Reminder 🌞", "Good morning! Don’t forget to mark your goals today.");
}, {
  timezone: "Asia/Kolkata"
});

// Night reminder at 10:00 PM IST
cron.schedule('0 22 * * *', () => {
  console.log('[CRON] Running night reminder at 10 PM IST');
  sendNotification("ZenTrack Reminder 🌙", "Day’s ending — check your progress before bed.");
}, {
  timezone: "Asia/Kolkata"
});

// ─── Subscribe endpoint ────────────────────────────────────────────────────────
app.post('/subscribe', isAuthenticated, async (req, res) => {
  try {
    const subscription = req.body;

    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Invalid subscription object' });
    }

    await PushSubscription.findOneAndUpdate(
      { user: req.user._id },
      { subscription, createdAt: new Date() },
      { upsert: true, new: true }
    );

    console.log(`[PUSH] Subscription saved/updated for user ${req.user._id}`);
    res.status(201).json({ success: true });
  } catch (err) {
    console.error('[PUSH] Save subscription error:', err);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

// Server listen
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`ZenTrack running on port ${port}`);
  console.log(`Current server time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
});

// Example route (kept as you had it)
app.get('/tracker', (req, res) => {
  res.render('tracker', { showGuide: true });  // or false
});