const express = require('express');
const twilio = require('twilio');
const moment = require('moment-timezone');

const app = express();
const PORT = process.env.PORT || 3000;

// Twilio client
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

app.use(express.json());

// Store active timeouts in memory (will reset on server restart)
const activeAlarms = new Map();

// Parse time input and calculate delay
function parseTimeInput(timeString) {
  const now = moment.tz('Asia/Kolkata');
  
  // Handle different formats: "5:30", "17:30", "tomorrow 6:00", "day after tomorrow 7:30"
  let targetTime;
  
  if (timeString.toLowerCase().includes('tomorrow')) {
    const timeOnly = timeString.replace(/tomorrow\s*/i, '').trim();
    targetTime = moment.tz('Asia/Kolkata').add(1, 'day');
    const [hours, minutes] = timeOnly.split(':').map(Number);
    targetTime.set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });
  } else if (timeString.toLowerCase().includes('day after tomorrow')) {
    const timeOnly = timeString.replace(/day after tomorrow\s*/i, '').trim();
    targetTime = moment.tz('Asia/Kolkata').add(2, 'days');
    const [hours, minutes] = timeOnly.split(':').map(Number);
    targetTime.set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });
  } else {
    // Today
    const [hours, minutes] = timeString.split(':').map(Number);
    targetTime = moment.tz('Asia/Kolkata');
    targetTime.set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });
    
    // If time has passed today, schedule for tomorrow
    if (targetTime.isBefore(now)) {
      targetTime.add(1, 'day');
    }
  }
  
  return targetTime;
}

// Make call function
async function makeCall(phoneNumber, message = null) {
  try {
    const callMessage = message || 'Wake up! This is your scheduled wake up call. Time to start your day!';
    
    const call = await twilioClient.calls.create({
      twiml: `<Response><Say voice="alice">${callMessage}</Say><Pause length="2"/><Say voice="alice">Have a great day!</Say></Response>`,
      to: phoneNumber,
      from: process.env.TWILIO_PHONE_NUMBER
    });
    
    console.log(`Call initiated: ${call.sid} to ${phoneNumber}`);
    return call.sid;
  } catch (error) {
    console.error('Error making call:', error);
    throw error;
  }
}

// Set alarm endpoint
app.post('/set-alarm', async (req, res) => {
  try {
    const { timeString, phoneNumber, message, userId } = req.body;
    
    if (!timeString || !phoneNumber) {
      return res.status(400).json({ 
        error: 'Missing required fields: timeString and phoneNumber' 
      });
    }

    const targetTime = parseTimeInput(timeString);
    const now = moment.tz('Asia/Kolkata');
    const delayMs = targetTime.diff(now);
    
    if (delayMs <= 0) {
      return res.status(400).json({ 
        error: 'Time has already passed' 
      });
    }

    // Create unique alarm ID
    const alarmId = `${userId}_${Date.now()}`;
    
    // Clear any existing alarm for this user
    if (activeAlarms.has(userId)) {
      clearTimeout(activeAlarms.get(userId).timeoutId);
    }
    
    // Schedule the call
    const timeoutId = setTimeout(async () => {
      try {
        await makeCall(phoneNumber, message);
        activeAlarms.delete(userId);
        console.log(`Wake up call completed for user: ${userId}`);
      } catch (error) {
        console.error('Error during scheduled call:', error);
        activeAlarms.delete(userId);
      }
    }, delayMs);
    
    // Store alarm info
    activeAlarms.set(userId, {
      alarmId,
      timeoutId,
      scheduledTime: targetTime.format('YYYY-MM-DD HH:mm:ss'),
      phoneNumber,
      message
    });

    res.json({
      success: true,
      message: `Alarm set for ${targetTime.format('YYYY-MM-DD HH:mm:ss IST')}`,
      alarmId,
      scheduledTime: targetTime.format('YYYY-MM-DD HH:mm:ss'),
      delayMinutes: Math.round(delayMs / 60000)
    });

  } catch (error) {
    console.error('Error setting alarm:', error);
    res.status(500).json({ error: 'Failed to set alarm' });
  }
});

// Cancel alarm endpoint
app.post('/cancel-alarm', (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    if (activeAlarms.has(userId)) {
      clearTimeout(activeAlarms.get(userId).timeoutId);
      activeAlarms.delete(userId);
      res.json({ success: true, message: 'Alarm cancelled' });
    } else {
      res.status(404).json({ error: 'No active alarm found for this user' });
    }
  } catch (error) {
    console.error('Error cancelling alarm:', error);
    res.status(500).json({ error: 'Failed to cancel alarm' });
  }
});

// Snooze alarm endpoint
app.post('/snooze-alarm', async (req, res) => {
  try {
    const { userId, minutes = 10 } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    if (!activeAlarms.has(userId)) {
      return res.status(404).json({ error: 'No active alarm found for this user' });
    }
    
    const alarm = activeAlarms.get(userId);
    
    // Cancel current alarm
    clearTimeout(alarm.timeoutId);
    
    // Schedule new alarm after snooze minutes
    const snoozeMs = minutes * 60 * 1000;
    const newTimeoutId = setTimeout(async () => {
      try {
        await makeCall(alarm.phoneNumber, alarm.message);
        activeAlarms.delete(userId);
        console.log(`Snoozed wake up call completed for user: ${userId}`);
      } catch (error) {
        console.error('Error during snoozed call:', error);
        activeAlarms.delete(userId);
      }
    }, snoozeMs);
    
    // Update alarm info
    const newScheduledTime = moment.tz('Asia/Kolkata').add(minutes, 'minutes');
    activeAlarms.set(userId, {
      ...alarm,
      timeoutId: newTimeoutId,
      scheduledTime: newScheduledTime.format('YYYY-MM-DD HH:mm:ss')
    });
    
    res.json({
      success: true,
      message: `Alarm snoozed for ${minutes} minutes`,
      newScheduledTime: newScheduledTime.format('YYYY-MM-DD HH:mm:ss')
    });
    
  } catch (error) {
    console.error('Error snoozing alarm:', error);
    res.status(500).json({ error: 'Failed to snooze alarm' });
  }
});

// Get active alarms
app.get('/active-alarms/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    
    if (activeAlarms.has(userId)) {
      const alarm = activeAlarms.get(userId);
      res.json({
        hasActiveAlarm: true,
        scheduledTime: alarm.scheduledTime,
        alarmId: alarm.alarmId
      });
    } else {
      res.json({ hasActiveAlarm: false });
    }
  } catch (error) {
    console.error('Error fetching active alarms:', error);
    res.status(500).json({ error: 'Failed to fetch active alarms' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: moment.tz('Asia/Kolkata').format(),
    activeAlarms: activeAlarms.size
  });
});

app.listen(PORT, () => {
  console.log(`Webhook service running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});