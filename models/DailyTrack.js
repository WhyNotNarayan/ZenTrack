const mongoose = require('mongoose');
const dailyTrackSchema = new mongoose.Schema({
  date: { type: Date, required: true },
  goal: { type: mongoose.Schema.Types.ObjectId, ref: 'Goal', required: true },
  completed: { type: Boolean, default: false },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
});
module.exports = mongoose.model('DailyTrack', dailyTrackSchema);