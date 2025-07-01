# Telegram Wake-up Call Scheduler

A service that integrates with n8n workflows to provide scheduled wake-up calls via Twilio to me.

## Features

- Set wake-up call alarms with simple time formats
- Cancel existing alarms
- Snooze alarms
- Check alarm status
- Integration with n8n workflows and Telegram bots

## Setup Instructions

### Prerequisites

- Node.js (v16 or higher)
- n8n instance
- Telegram Bot (created via BotFather)
- Twilio account (for making calls)

### Environment Variables

The service requires the following environment variables:

```
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_PHONE_NUMBER=your_twilio_phone_number
PORT=3000 (optional, defaults to 3000)
```

### Installation

1. Clone the repository
2. Install dependencies:
   ```
   npm install
   ```
3. Start the server:
   ```
   npm start
   ```

### Deployment

This service can be deployed to platforms like Render, Heroku, or any other Node.js hosting service.

For Render:
1. Create a new Web Service
2. Connect your repository
3. Set the build command: `npm install`
4. Set the start command: `node server.js`
5. Add the environment variables

### n8n Workflow Setup

1. Import the `workflow.json` file into your n8n instance
2. Update the HTTP request node URLs to match your deployed server URL
3. Set up the Telegram trigger node with your bot token

## API Endpoints

- `POST /set-alarm`: Set a new alarm
- `POST /cancel-alarm`: Cancel an existing alarm
- `POST /snooze-alarm`: Snooze an existing alarm
- `GET /active-alarms/:userId`: Get active alarms for a user
- `GET /health`: Health check endpoint
- `GET /`: Service information

## Time Format Examples

- `7:30` - Today at 7:30 AM (or tomorrow if the time has passed)
- `17:45` - Today at 5:45 PM
- `tomorrow 8:00` - Tomorrow at 8:00 AM
- `day after tomorrow 9:15` - Day after tomorrow at 9:15 AM
