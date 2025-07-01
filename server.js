const express = require('express');
const twilio = require('twilio');
const moment = require('moment-timezone');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all routes
app.use(cors());

// Twilio client
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Add request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} | ${req.method} ${req.url}`);
  next();
});

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
    // Validate Twilio credentials are set
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) {
      console.error('Twilio credentials not set in environment variables');
      throw new Error('Twilio credentials not configured');
    }
    
    const callMessage = message || 'Wake up! This is your scheduled wake up call. Time to start your day!';
    
    const call = await twilioClient.calls.create({
      twiml: `<Response><Say voice="alice">${callMessage}</Say><Pause length="2"/><Say voice="alice">Have a great day!</Say></Response>`,
      to: phoneNumber,
      from: process.env.TWILIO_PHONE_NUMBER
    });
    
    console.log(`Call initiated: ${call.sid} to ${phoneNumber}`);
    return call.sid;
  } catch (error) {
    console.error('Error making call:', error.message);
    console.error('Full error:', error);
    throw error;
  }
}

// Set alarm endpoint
app.post('/set-alarm', async (req, res) => {
  try {
    console.log('Received set-alarm request:', JSON.stringify(req.body));
    
    const { timeString, phoneNumber, message, userId } = req.body;
    
    if (!timeString || !phoneNumber) {
      console.error('Missing required fields:', { timeString, phoneNumber });
      return res.status(400).json({ 
        error: 'Missing required fields: timeString and phoneNumber' 
      });
    }

    // Validate phone number format (simple validation)
    if (!phoneNumber.startsWith('+')) {
      console.error('Invalid phone number format (must start with +):', phoneNumber);
      return res.status(400).json({
        error: 'Invalid phone number format. Must include country code and start with +'
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
    
    // Ensure userId is stored as string for consistent comparison
    const userIdString = userId ? userId.toString() : null;
    
    console.log('Setting alarm for userId:', userIdString);
    
    // Clear any existing alarm for this user
    if (activeAlarms.has(userIdString)) {
      console.log('Clearing existing alarm for user:', userIdString);
      clearTimeout(activeAlarms.get(userIdString).timeoutId);
    }
    
    // Schedule the call
    const timeoutId = setTimeout(async () => {
      try {
        await makeCall(phoneNumber, message);
        activeAlarms.delete(userIdString);
        console.log(`Wake up call completed for user: ${userIdString}`);
      } catch (error) {
        console.error('Error during scheduled call:', error);
        activeAlarms.delete(userIdString);
      }
    }, delayMs);
    
    // Store alarm info
    activeAlarms.set(userIdString, {
      alarmId,
      timeoutId,
      scheduledTime: targetTime.format('YYYY-MM-DD HH:mm:ss'),
      phoneNumber,
      message,
      userId: userIdString
    });

    console.log('Alarm stored for user:', userIdString);
    console.log('Current active alarms:', Array.from(activeAlarms.keys()));

    res.json({
      success: true,
      message: `Alarm set for ${targetTime.format('YYYY-MM-DD HH:mm:ss IST')}`,
      alarmId,
      scheduledTime: targetTime.format('YYYY-MM-DD HH:mm:ss'),
      delayMinutes: Math.round(delayMs / 60000),
      userId: userIdString // Adding this for debugging
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
    
    const userIdString = userId.toString();
    console.log('Cancelling alarm for userId:', userIdString);
    
    if (activeAlarms.has(userIdString)) {
      clearTimeout(activeAlarms.get(userIdString).timeoutId);
      activeAlarms.delete(userIdString);
      console.log('Alarm cancelled for user:', userIdString);
      res.json({ success: true, message: 'Alarm cancelled' });
    } else {
      console.log('No active alarm found to cancel for user:', userIdString);
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
    
    const userIdString = userId.toString();
    console.log('Snoozing alarm for userId:', userIdString);
    
    if (!activeAlarms.has(userIdString)) {
      console.log('No active alarm found to snooze for user:', userIdString);
      return res.status(404).json({ error: 'No active alarm found for this user' });
    }
    
    const alarm = activeAlarms.get(userIdString);
    
    // Cancel current alarm
    clearTimeout(alarm.timeoutId);
    
    // Schedule new alarm after snooze minutes
    const snoozeMs = minutes * 60 * 1000;
    const newTimeoutId = setTimeout(async () => {
      try {
        await makeCall(alarm.phoneNumber, alarm.message);
        activeAlarms.delete(userIdString);
        console.log(`Snoozed wake up call completed for user: ${userIdString}`);
      } catch (error) {
        console.error('Error during snoozed call:', error);
        activeAlarms.delete(userIdString);
      }
    }, snoozeMs);
    
    // Update alarm info
    const newScheduledTime = moment.tz('Asia/Kolkata').add(minutes, 'minutes');
    activeAlarms.set(userIdString, {
      ...alarm,
      timeoutId: newTimeoutId,
      scheduledTime: newScheduledTime.format('YYYY-MM-DD HH:mm:ss')
    });
    
    console.log('Alarm snoozed for user:', userIdString);
    
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

// Debug endpoint to see all active alarms
app.get('/debug/alarms', (req, res) => {
  try {
    const alarms = {};
    for (const [userId, alarm] of activeAlarms.entries()) {
      alarms[userId] = {
        alarmId: alarm.alarmId,
        scheduledTime: alarm.scheduledTime,
        phoneNumber: alarm.phoneNumber,
        message: alarm.message
      };
    }
    
    res.json({
      totalActiveAlarms: activeAlarms.size,
      alarms: alarms,
      userIds: Array.from(activeAlarms.keys())
    });
  } catch (error) {
    console.error('Error fetching debug alarms:', error);
    res.status(500).json({ error: 'Failed to fetch debug alarms' });
  }
});

// Get active alarms
app.get('/active-alarms/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    
    console.log('Checking active alarms for userId:', userId);
    console.log('Active alarms map keys:', Array.from(activeAlarms.keys()));
    console.log('Active alarms map size:', activeAlarms.size);
    
    // Convert userId to string to ensure consistent comparison
    const userIdString = userId.toString();
    
    if (activeAlarms.has(userIdString)) {
      const alarm = activeAlarms.get(userIdString);
      console.log('Found active alarm for user:', userIdString, alarm);
      res.json({
        hasActiveAlarm: true,
        scheduledTime: alarm.scheduledTime,
        alarmId: alarm.alarmId,
        phoneNumber: alarm.phoneNumber // Adding this for debugging
      });
    } else {
      console.log('No active alarm found for user:', userIdString);
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

// Default route
app.get('/', (req, res) => {
  res.json({ 
    service: 'Telegram Wake-up Call Scheduler',
    status: 'Running',
    endpoints: [
      '/set-alarm (POST)',
      '/cancel-alarm (POST)',
      '/snooze-alarm (POST)',
      '/active-alarms/:userId (GET)',
      '/debug/alarms (GET)',
      '/health (GET)'
    ],
    timestamp: moment.tz('Asia/Kolkata').format()
  });
});

app.listen(PORT, () => {
  console.log(`Webhook service running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  
  // Log environment check for Twilio credentials
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) {
    console.warn('WARNING: Twilio credentials are not properly set in environment variables!');
    console.warn('Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER environment variables.');
  } else {
    console.log('Twilio credentials loaded successfully');
  }
});