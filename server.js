const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();

// Security middlewares
app.use(helmet());
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

// Stricter rate limit for scheduling endpoints
const scheduleLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10, // limit each IP to 10 schedule requests per minute
    message: 'Too many scheduling requests, please try again later.'
});

// In-memory storage (for production, use Redis or Database)
const activeSchedules = new Map();
const userAlarms = new Map(); // userId -> array of alarms
const authorizedUsers = new Set(); // Store authorized user IDs
const userCustomMessages = new Map(); // userId -> custom message

// Environment variables
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n-z89h.onrender.com';
const AUTH_TOKEN = process.env.AUTH_TOKEN || '7721301321:AAHrxdLERI16-JtrWcUy5E2-4EwrQQHnnRU';
const ADMIN_USER_ID = process.env.ADMIN_USER_ID; // Your Telegram user ID

// Middleware for authentication
const authenticate = (req, res, next) => {
    const token = req.headers.authorization;
    if (token !== `Bearer ${AUTH_TOKEN}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

// Middleware for user authorization
const authorizeUser = (req, res, next) => {
    const { userId } = req.body;
    if (!authorizedUsers.has(userId) && userId !== ADMIN_USER_ID) {
        return res.status(403).json({ error: 'User not authorized' });
    }
    next();
};

// Input validation
const validateTimeFormat = (time) => {
    const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
    return timeRegex.test(time);
};

const validateRecurrence = (recurrence) => {
    const validTypes = ['none', 'daily', 'weekly', 'weekdays'];
    return validTypes.includes(recurrence);
};

// Utility functions
const generateAlarmId = () => {
    return Date.now().toString() + Math.random().toString(36).substr(2, 5);
};

const parseCronExpression = (time, recurrence = 'none', dayOfWeek = null) => {
    const [hours, minutes] = time.split(':').map(Number);
    
    switch (recurrence) {
        case 'daily':
            return `${minutes} ${hours} * * *`;
        case 'weekly':
            const day = dayOfWeek || new Date().getDay();
            return `${minutes} ${hours} * * ${day}`;
        case 'weekdays':
            return `${minutes} ${hours} * * 1-5`;
        default:
            // One-time alarm
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            return `${minutes} ${hours} ${tomorrow.getDate()} ${tomorrow.getMonth() + 1} *`;
    }
};

const createScheduledTask = (alarmData) => {
    const { alarmId, userId, time, cronExpression, recurrence, customMessage } = alarmData;
    
    const task = cron.schedule(cronExpression, async () => {
        try {
            // Trigger the n8n webhook to make the call
            await axios.post(`${N8N_WEBHOOK_URL}/webhook/call-webhook`, {
                userId: userId,
                alarmId: alarmId,
                customMessage: customMessage || 'Wake up! Time to start your day!',
                time: time
            }, {
                headers: {
                    'Authorization': `Bearer ${AUTH_TOKEN}`
                }
            });
            
            console.log(`Wake-up call triggered for user ${userId} at ${time}`);
            
            // If it's a one-time alarm, remove it after execution
            if (recurrence === 'none') {
                task.destroy();
                activeSchedules.delete(alarmId);
                
                // Remove from user's alarm list
                const userAlarmsList = userAlarms.get(userId) || [];
                const updatedAlarms = userAlarmsList.filter(alarm => alarm.alarmId !== alarmId);
                userAlarms.set(userId, updatedAlarms);
            }
            
        } catch (error) {
            console.error('Error making wake-up call:', error);
        }
    }, {
        scheduled: false,
        timezone: "Asia/Kolkata"
    });
    
    return task;
};

// Initialize admin user
if (ADMIN_USER_ID) {
    authorizedUsers.add(ADMIN_USER_ID);
}

// Routes

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        activeSchedules: activeSchedules.size,
        totalUsers: userAlarms.size,
        uptime: process.uptime()
    });
});

// User authorization endpoint (admin only)
app.post('/authorize-user', authenticate, (req, res) => {
    const { userId, adminUserId } = req.body;
    
    if (adminUserId !== ADMIN_USER_ID) {
        return res.status(403).json({ error: 'Only admin can authorize users' });
    }
    
    authorizedUsers.add(userId);
    res.json({ success: true, message: 'User authorized successfully' });
});

// Schedule a new alarm
app.post('/webhook/schedule-alarm', scheduleLimiter, authenticate, authorizeUser, (req, res) => {
    const { userId, time, recurrence = 'none', dayOfWeek, customMessage, label } = req.body;
    
    // Validate input
    if (!validateTimeFormat(time)) {
        return res.status(400).json({ error: 'Invalid time format. Use HH:MM (24-hour format)' });
    }
    
    if (!validateRecurrence(recurrence)) {
        return res.status(400).json({ error: 'Invalid recurrence type' });
    }
    
    // Check user alarm limit (max 10 alarms per user)
    const userAlarmsList = userAlarms.get(userId) || [];
    if (userAlarmsList.length >= 10) {
        return res.status(400).json({ error: 'Maximum 10 alarms allowed per user' });
    }
    
    try {
        const alarmId = generateAlarmId();
        const cronExpression = parseCronExpression(time, recurrence, dayOfWeek);
        
        const alarmData = {
            alarmId,
            userId,
            time,
            recurrence,
            dayOfWeek,
            customMessage,
            label: label || `Alarm at ${time}`,
            createdAt: new Date().toISOString(),
            cronExpression
        };
        
        // Create and start the scheduled task
        const task = createScheduledTask(alarmData);
        task.start();
        
        // Store the task and alarm data
        activeSchedules.set(alarmId, task);
        userAlarmsList.push(alarmData);
        userAlarms.set(userId, userAlarmsList);
        
        res.json({ 
            success: true, 
            message: 'Alarm scheduled successfully',
            alarmId,
            scheduledFor: time,
            recurrence
        });
        
    } catch (error) {
        console.error('Error scheduling alarm:', error);
        res.status(500).json({ error: 'Failed to schedule alarm' });
    }
});

// Get user's alarms
app.get('/user-alarms/:userId', authenticate, (req, res) => {
    const { userId } = req.params;
    
    if (!authorizedUsers.has(userId) && userId !== ADMIN_USER_ID) {
        return res.status(403).json({ error: 'User not authorized' });
    }
    
    const userAlarmsList = userAlarms.get(userId) || [];
    res.json({ alarms: userAlarmsList });
});

// Delete an alarm
app.delete('/alarm/:alarmId', authenticate, (req, res) => {
    const { alarmId } = req.params;
    const { userId } = req.query;
    
    if (!authorizedUsers.has(userId) && userId !== ADMIN_USER_ID) {
        return res.status(403).json({ error: 'User not authorized' });
    }
    
    // Check if alarm exists and belongs to user
    const userAlarmsList = userAlarms.get(userId) || [];
    const alarmIndex = userAlarmsList.findIndex(alarm => alarm.alarmId === alarmId);
    
    if (alarmIndex === -1) {
        return res.status(404).json({ error: 'Alarm not found' });
    }
    
    // Stop and remove the scheduled task
    if (activeSchedules.has(alarmId)) {
        activeSchedules.get(alarmId).destroy();
        activeSchedules.delete(alarmId);
    }
    
    // Remove from user's alarm list
    userAlarmsList.splice(alarmIndex, 1);
    userAlarms.set(userId, userAlarmsList);
    
    res.json({ success: true, message: 'Alarm deleted successfully' });
});

// Snooze alarm (reschedule for 5 minutes later)
app.post('/snooze-alarm', authenticate, authorizeUser, (req, res) => {
    const { userId, originalTime } = req.body;
    
    // Calculate snooze time (5 minutes later)
    const [hours, minutes] = originalTime.split(':').map(Number);
    const snoozeDate = new Date();
    snoozeDate.setHours(hours, minutes, 0, 0);
    snoozeDate.setMinutes(snoozeDate.getMinutes() + 5);
    
    // If snooze time is past midnight, set for tomorrow
    if (snoozeDate < new Date()) {
        snoozeDate.setDate(snoozeDate.getDate() + 1);
    }
    
    const snoozeTime = `${snoozeDate.getHours().toString().padStart(2, '0')}:${snoozeDate.getMinutes().toString().padStart(2, '0')}`;
    
    // Schedule snooze alarm
    const alarmId = generateAlarmId();
    const cronExpression = `${snoozeDate.getMinutes()} ${snoozeDate.getHours()} ${snoozeDate.getDate()} ${snoozeDate.getMonth() + 1} *`;
    
    const alarmData = {
        alarmId,
        userId,
        time: snoozeTime,
        recurrence: 'none',
        label: `Snoozed alarm (${snoozeTime})`,
        createdAt: new Date().toISOString(),
        cronExpression
    };
    
    const task = createScheduledTask(alarmData);
    task.start();
    
    activeSchedules.set(alarmId, task);
    const userAlarmsList = userAlarms.get(userId) || [];
    userAlarmsList.push(alarmData);
    userAlarms.set(userId, userAlarmsList);
    
    res.json({ 
        success: true, 
        message: `Alarm snoozed for 5 minutes (${snoozeTime})`,
        snoozeTime 
    });
});

// Set custom message
app.post('/set-custom-message', authenticate, authorizeUser, (req, res) => {
    const { userId, customMessage } = req.body;
    
    if (!customMessage || customMessage.length > 200) {
        return res.status(400).json({ error: 'Custom message must be 1-200 characters long' });
    }
    
    userCustomMessages.set(userId, customMessage);
    res.json({ success: true, message: 'Custom message set successfully' });
});

// Get custom message
app.get('/custom-message/:userId', authenticate, (req, res) => {
    const { userId } = req.params;
    
    if (!authorizedUsers.has(userId) && userId !== ADMIN_USER_ID) {
        return res.status(403).json({ error: 'User not authorized' });
    }
    
    const customMessage = userCustomMessages.get(userId) || 'Wake up! Time to start your day!';
    res.json({ customMessage });
});

// Admin endpoint to view all users and their alarms
app.get('/admin/all-users', authenticate, (req, res) => {
    const { adminUserId } = req.query;
    
    if (adminUserId !== ADMIN_USER_ID) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    
    const allUsers = {};
    for (const [userId, alarms] of userAlarms.entries()) {
        allUsers[userId] = {
            alarmCount: alarms.length,
            alarms: alarms
        };
    }
    
    res.json({ 
        totalUsers: userAlarms.size,
        authorizedUsers: Array.from(authorizedUsers),
        users: allUsers 
    });
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Enhanced Scheduler Service running on port ${PORT}`);
    console.log(`Authorized users: ${authorizedUsers.size}`);
});