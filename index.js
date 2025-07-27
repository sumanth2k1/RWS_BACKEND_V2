const express = require('express');
const mongoose = require('mongoose');
const WebSocket = require('ws');
const http = require('http');
const cors = require('cors');
const Agenda = require('agenda');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// WebSocket Server
const wss = new WebSocket.Server({ 
  server,
  path: '/ws',
  perMessageDeflate: false // Better for ESP8266
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Environment variables
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/watering_system';

// MongoDB Connection
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
})
.then(() => console.log('✅ Connected to MongoDB'))
.catch(err => console.error('❌ MongoDB connection error:', err));

// Initialize Agenda for job scheduling
const agenda = new Agenda({ 
  db: { address: MONGODB_URI },
  processEvery: '30 seconds',
  maxConcurrency: 20
});

// Device Schema
const deviceSchema = new mongoose.Schema({
  deviceId: { 
    type: String, 
    required: true, 
    unique: true 
  },
  ip: String,
  lastSeen: { 
    type: Date, 
    default: Date.now 
  },
  status: { 
    type: String, 
    enum: ['online', 'offline'], 
    default: 'offline' 
  },
  pumpStatus: {
    type: String,
    enum: ['idle', 'running'],
    default: 'idle'
  },
  connectionAttempts: {
    type: Number,
    default: 0
  },
  lastConnectionError: String,
  createdAt: { 
    type: Date, 
    default: Date.now 
  }
});

const Device = mongoose.model('Device', deviceSchema);

// Schedule Schema
const scheduleSchema = new mongoose.Schema({
  deviceId: { 
    type: String, 
    required: true 
  },
  time: { 
    type: Date, 
    required: true 
  },
  duration: { 
    type: Number, 
    required: true 
  },
  executed: { 
    type: Boolean, 
    default: false 
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  executedAt: Date,
  status: {
    type: String,
    enum: ['pending', 'executed', 'failed', 'expired'],
    default: 'pending'
  },
  retryCount: {
    type: Number,
    default: 0
  },
  lastError: String
});

const Schedule = mongoose.model('Schedule', scheduleSchema);

// Connection tracking
const connectedDevices = new Map();
const connectedFrontends = new Map();
const connectionStats = {
  totalConnections: 0,
  activeConnections: 0,
  deviceConnections: 0,
  frontendConnections: 0
};

// WebSocket message types
const MESSAGE_TYPE = {
  // Device messages
  DEVICE_JOIN: 'device_join',
  DEVICE_STATUS: 'device_status',
  PUMP_STATUS: 'pump_status',
  HEARTBEAT: 'heartbeat',
  COMMAND_ACK: 'command_ack',
  SCHEDULE_EXECUTED: 'schedule_executed',
  
  // Frontend messages
  FRONTEND_JOIN: 'frontend_join',
  MANUAL_COMMAND: 'manual_command',
  
  // Server messages
  WATER_COMMAND: 'water_command',
  DEVICE_JOINED: 'device_joined',
  HEARTBEAT_ACK: 'heartbeat_ack',
  ERROR: 'error',
  
  // Broadcast messages
  DEVICE_CONNECTED: 'device_connected',
  DEVICE_DISCONNECTED: 'device_disconnected',
  PUMP_STATUS_UPDATE: 'pump_status_update'
};

// Utility functions
function sendMessage(ws, type, data = {}) {
  if (ws.readyState === WebSocket.OPEN) {
    const message = JSON.stringify({
      type,
      data,
      timestamp: new Date().toISOString()
    });
    ws.send(message);
    return true;
  }
  return false;
}

function broadcastToFrontends(type, data) {
  connectedFrontends.forEach((info, ws) => {
    sendMessage(ws, type, data);
  });
}

function sendToDevice(deviceId, type, data) {
  const deviceInfo = connectedDevices.get(deviceId);
  if (deviceInfo && deviceInfo.ws) {
    return sendMessage(deviceInfo.ws, type, data);
  }
  return false;
}

// WebSocket connection handling
wss.on('connection', (ws, req) => {
  connectionStats.totalConnections++;
  connectionStats.activeConnections++;
  
  console.log(`🔌 WebSocket client connected from ${req.socket.remoteAddress}`);
  
  // Send welcome message
  sendMessage(ws, 'connected', { 
    status: 'connected',
    timestamp: new Date().toISOString(),
    serverVersion: '2.0'
  });

  ws.on('message', async (message) => {
    try {
      const parsedMessage = JSON.parse(message);
      const { type, data } = parsedMessage;
      
      console.log(`📥 WebSocket message: ${type}`, data);
      
      await handleWebSocketMessage(ws, type, data);
      
    } catch (error) {
      console.error('❌ Error parsing WebSocket message:', error);
      sendMessage(ws, MESSAGE_TYPE.ERROR, { 
        error: 'Invalid message format',
        details: error.message 
      });
    }
  });

  ws.on('close', async (code, reason) => {
    connectionStats.activeConnections--;
    console.log(`❌ WebSocket client disconnected: ${code} - ${reason}`);
    
    // Handle device disconnection
    for (let [deviceId, deviceInfo] of connectedDevices.entries()) {
      if (deviceInfo.ws === ws) {
        console.log(`📱 Device ${deviceId} disconnected`);
        
        connectedDevices.delete(deviceId);
        connectionStats.deviceConnections--;
        
        // Update device status in database
        await Device.findOneAndUpdate(
          { deviceId },
          { 
            status: 'offline',
            pumpStatus: 'idle',
            lastSeen: new Date()
          }
        );
        
        // Notify frontend clients
        broadcastToFrontends(MESSAGE_TYPE.DEVICE_DISCONNECTED, {
          deviceId,
          status: 'offline',
          timestamp: new Date().toISOString()
        });
        
        break;
      }
    }
    
    // Handle frontend disconnection
    if (connectedFrontends.has(ws)) {
      connectedFrontends.delete(ws);
      connectionStats.frontendConnections--;
      console.log('🖥️ Frontend client disconnected');
    }
  });

  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
  });

  // Send ping every 30 seconds to keep connection alive
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);
});

// WebSocket message handler
async function handleWebSocketMessage(ws, type, data) {
  switch (type) {
    case MESSAGE_TYPE.DEVICE_JOIN:
      await handleDeviceJoin(ws, data);
      break;
      
    case MESSAGE_TYPE.PUMP_STATUS:
      await handlePumpStatus(ws, data);
      break;
      
    case MESSAGE_TYPE.HEARTBEAT:
      await handleHeartbeat(ws, data);
      break;
      
    case MESSAGE_TYPE.COMMAND_ACK:
      await handleCommandAck(ws, data);
      break;
      
    case MESSAGE_TYPE.SCHEDULE_EXECUTED:
      await handleScheduleExecuted(ws, data);
      break;
      
    case MESSAGE_TYPE.FRONTEND_JOIN:
      await handleFrontendJoin(ws);
      break;
      
    case MESSAGE_TYPE.MANUAL_COMMAND:
      await handleManualCommand(ws, data);
      break;
      
    default:
      console.warn(`❓ Unknown message type: ${type}`);
      sendMessage(ws, MESSAGE_TYPE.ERROR, { 
        error: 'Unknown message type',
        type 
      });
  }
}

// Message handlers
async function handleDeviceJoin(ws, data) {
  const { deviceId } = data;
  
  if (!deviceId) {
    sendMessage(ws, MESSAGE_TYPE.ERROR, { error: 'Device ID is required' });
    return;
  }
  
  try {
    console.log(`📱 Device ${deviceId} joining`);
    
    // Check if device was already connected
    const existingConnection = connectedDevices.get(deviceId);
    if (existingConnection && existingConnection.ws !== ws) {
      console.log(`⚠️ Device ${deviceId} reconnecting with new WebSocket`);
      // Close old connection
      if (existingConnection.ws.readyState === WebSocket.OPEN) {
        existingConnection.ws.close();
      }
    }
    
    // Store device connection
    connectedDevices.set(deviceId, {
      ws,
      joinedAt: new Date(),
      lastSeen: new Date(),
      reconnectCount: existingConnection ? (existingConnection.reconnectCount || 0) + 1 : 0
    });
    
    connectionStats.deviceConnections++;
    
    // Update device status in database
    const device = await Device.findOneAndUpdate(
      { deviceId },
      { 
        status: 'online',
        lastSeen: new Date(),
        connectionAttempts: 0,
        lastConnectionError: null
      },
      { 
        upsert: true,
        new: true,
        runValidators: true
      }
    );
    
    console.log(`✅ Device ${deviceId} successfully joined`);
    
    // Send confirmation to device
    sendMessage(ws, MESSAGE_TYPE.DEVICE_JOINED, { 
      deviceId, 
      status: 'success',
      message: 'Successfully joined',
      reconnectCount: connectedDevices.get(deviceId).reconnectCount
    });
    
    // Notify frontend clients
    broadcastToFrontends(MESSAGE_TYPE.DEVICE_CONNECTED, {
      deviceId,
      status: 'online',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error(`❌ Error handling device join for ${deviceId}:`, error);
    
    await Device.findOneAndUpdate(
      { deviceId },
      { 
        $inc: { connectionAttempts: 1 },
        lastConnectionError: error.message,
        lastSeen: new Date()
      }
    ).catch(err => console.error('Failed to update DB:', err));
    
    sendMessage(ws, MESSAGE_TYPE.ERROR, { 
      error: 'Failed to join',
      details: error.message,
      deviceId
    });
  }
}

async function handlePumpStatus(ws, data) {
  const { deviceId, status } = data;
  
  if (!deviceId || !status) {
    sendMessage(ws, MESSAGE_TYPE.ERROR, { error: 'Invalid pump status data' });
    return;
  }
  
  try {
    console.log(`💧 Pump status update: ${deviceId} - ${status}`);
    
    // Update device pump status
    const device = await Device.findOneAndUpdate(
      { deviceId },
      { 
        pumpStatus: status === 'stopped' ? 'idle' : status,
        lastSeen: new Date()
      },
      { new: true }
    );
    
    if (!device) {
      sendMessage(ws, MESSAGE_TYPE.ERROR, { error: 'Device not found' });
      return;
    }
    
    // Update connection tracking
    const connection = connectedDevices.get(deviceId);
    if (connection) {
      connection.lastSeen = new Date();
    }
    
    // Broadcast to frontend clients
    broadcastToFrontends(MESSAGE_TYPE.PUMP_STATUS_UPDATE, {
      deviceId,
      status,
      timestamp: new Date().toISOString(),
      deviceStatus: device.status,
      lastSeen: device.lastSeen
    });
    
    // Send acknowledgment
    sendMessage(ws, 'status_received', { 
      deviceId,
      status: 'acknowledged'
    });
    
  } catch (error) {
    console.error('❌ Error handling pump status:', error);
    sendMessage(ws, MESSAGE_TYPE.ERROR, { 
      error: 'Failed to process status update',
      details: error.message
    });
  }
}

async function handleHeartbeat(ws, data) {
  const { deviceId } = data;
  
  if (deviceId) {
    const connection = connectedDevices.get(deviceId);
    if (connection) {
      connection.lastSeen = new Date();
    }
    
    // Update device last seen in database
    await Device.findOneAndUpdate(
      { deviceId },
      { lastSeen: new Date() }
    ).catch(err => console.error('Failed to update heartbeat:', err));
    
    // Send heartbeat acknowledgment
    sendMessage(ws, MESSAGE_TYPE.HEARTBEAT_ACK, { 
      timestamp: new Date().toISOString(),
      serverTime: Date.now()
    });
  }
}

async function handleCommandAck(ws, data) {
  const { commandId, deviceId, status } = data;
  
  if (commandId && deviceId) {
    console.log(`✅ Command acknowledged by device ${deviceId}: ${commandId}`);
    
    // Notify frontend
    broadcastToFrontends('command_acknowledged', {
      deviceId,
      commandId,
      status,
      timestamp: new Date().toISOString()
    });
  }
}

async function handleScheduleExecuted(ws, data) {
  const { scheduleId, deviceId } = data;
  
  if (scheduleId && deviceId) {
    console.log(`✅ Schedule execution confirmed by device ${deviceId}: ${scheduleId}`);
    
    // Update schedule status
    await Schedule.findByIdAndUpdate(scheduleId, {
      status: 'executed',
      executedAt: new Date()
    }).catch(err => console.error('Failed to update schedule:', err));
    
    // Notify frontend
    broadcastToFrontends('schedule_execution_confirmed', {
      deviceId,
      scheduleId,
      timestamp: new Date().toISOString()
    });
  }
}

async function handleFrontendJoin(ws) {
  try {
    console.log('🖥️ Frontend client joined');
    
    connectedFrontends.set(ws, {
      joinedAt: new Date(),
      lastActivity: new Date()
    });
    
    connectionStats.frontendConnections++;
    
    // Send current system status
    const devices = await Device.find().lean();
    const activeSchedules = await Schedule.find({ 
      status: 'pending',
      time: { $gte: new Date() }
    }).lean();
    
    sendMessage(ws, 'frontend_joined', {
      status: 'success',
      systemStatus: {
        totalDevices: devices.length,
        onlineDevices: devices.filter(d => d.status === 'online').length,
        activeSchedules: activeSchedules.length,
        connectionStats
      },
      devices: devices.map(d => ({
        deviceId: d.deviceId,
        status: d.status,
        pumpStatus: d.pumpStatus,
        lastSeen: d.lastSeen
      }))
    });
    
  } catch (error) {
    console.error('❌ Error handling frontend join:', error);
    sendMessage(ws, MESSAGE_TYPE.ERROR, { 
      error: 'Failed to join frontend',
      details: error.message
    });
  }
}

async function handleManualCommand(ws, data) {
  const { deviceId, action, duration } = data;
  
  if (!deviceId || !action) {
    sendMessage(ws, MESSAGE_TYPE.ERROR, { error: 'Device ID and action are required' });
    return;
  }
  
  try {
    // Check if device exists and is online
    const device = await Device.findOne({ deviceId });
    if (!device) {
      sendMessage(ws, MESSAGE_TYPE.ERROR, { error: 'Device not found' });
      return;
    }
    
    if (device.status !== 'online') {
      sendMessage(ws, MESSAGE_TYPE.ERROR, { 
        error: 'Device is offline',
        deviceStatus: device.status,
        lastSeen: device.lastSeen
      });
      return;
    }
    
    const commandData = {
      action,
      duration: duration || 0,
      commandId: `cmd_${Date.now()}`,
      timestamp: new Date().toISOString()
    };
    
    // Send command to device
    const sent = sendToDevice(deviceId, MESSAGE_TYPE.WATER_COMMAND, commandData);
    
    if (sent) {
      sendMessage(ws, 'command_sent', {
        success: true,
        message: `Command sent to device ${deviceId}`,
        command: commandData
      });
    } else {
      sendMessage(ws, MESSAGE_TYPE.ERROR, { 
        error: 'Failed to send command - device not connected'
      });
    }
    
  } catch (error) {
    console.error('❌ Manual command error:', error);
    sendMessage(ws, MESSAGE_TYPE.ERROR, {
      error: 'Failed to send command',
      details: error.message
    });
  }
}

// Connection monitoring
setInterval(async () => {
  try {
    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    
    // Check for stale connections
    for (let [deviceId, connectionInfo] of connectedDevices.entries()) {
      if (connectionInfo.lastSeen < fiveMinutesAgo) {
        console.log(`⚠️ Cleaning up stale connection for device: ${deviceId}`);
        
        connectedDevices.delete(deviceId);
        connectionStats.deviceConnections--;
        
        // Update database
        await Device.findOneAndUpdate(
          { deviceId },
          { 
            status: 'offline',
            pumpStatus: 'idle'
          }
        );
        
        // Notify frontends
        broadcastToFrontends(MESSAGE_TYPE.DEVICE_DISCONNECTED, {
          deviceId,
          status: 'offline',
          reason: 'timeout',
          timestamp: now.toISOString()
        });
      }
    }
    
  } catch (error) {
    console.error('❌ Error in connection cleanup:', error);
  }
}, 60000);

// REST API Routes (keeping existing ones)
app.post('/api/devices/register', async (req, res) => {
  try {
    const { deviceId, ip } = req.body;

    if (!deviceId) {
      return res.status(400).json({ error: 'Device ID is required' });
    }

    console.log(`📡 Device registration request: ${deviceId} from IP: ${ip}`);

    let device = await Device.findOne({ deviceId });

    if (device) {
      device.ip = ip;
      device.lastSeen = new Date();
      device.status = 'online';
      device.connectionAttempts = 0;
      device.lastConnectionError = null;
      await device.save();
      console.log(`🔄 Updated existing device: ${deviceId}`);
    } else {
      device = new Device({
        deviceId,
        ip,
        status: 'online'
      });
      await device.save();
      console.log(`✅ Registered new device: ${deviceId}`);
    }

    res.json({
      success: true,
      message: 'Device registered successfully',
      device: {
        deviceId: device.deviceId,
        status: device.status,
        lastSeen: device.lastSeen
      },
      serverInfo: {
        wsUrl: `ws://${req.get('host')}/ws`,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Device registration error:', error);
    res.status(500).json({
      error: 'Failed to register device',
      details: error.message
    });
  }
});

// Manual water command via REST API
app.post('/api/devices/:deviceId/water', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { action, duration } = req.body;

    if (!action) {
      return res.status(400).json({ error: 'Action is required' });
    }

    const device = await Device.findOne({ deviceId });
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    if (device.status !== 'online') {
      return res.status(409).json({ 
        error: 'Device is offline',
        deviceStatus: device.status,
        lastSeen: device.lastSeen
      });
    }

    const commandData = {
      action,
      duration: duration || 0,
      commandId: `cmd_${Date.now()}`,
      timestamp: new Date().toISOString()
    };

    const sent = sendToDevice(deviceId, MESSAGE_TYPE.WATER_COMMAND, commandData);

    if (sent) {
      res.json({
        success: true,
        message: `Water command sent to device ${deviceId}`,
        command: commandData
      });
    } else {
      res.status(409).json({ 
        error: 'Device is not connected via WebSocket'
      });
    }

  } catch (error) {
    console.error('❌ Manual water command error:', error);
    res.status(500).json({
      error: 'Failed to send water command',
      details: error.message
    });
  }
});

// Get device info
app.get('/api/devices/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const device = await Device.findOne({ deviceId });
    
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    res.json({
      success: true,
      device
    });

  } catch (error) {
    console.error('❌ Get device error:', error);
    res.status(500).json({
      error: 'Failed to get device',
      details: error.message
    });
  }
});

// Schedule endpoints (keeping existing ones)
app.get('/api/devices/:deviceId/schedules', async (req, res) => {
  try {
    const { deviceId } = req.params;
    
    const schedules = await Schedule.find({
      deviceId,
      status: 'pending',
      time: { $gte: new Date() }
    }).sort({ time: 1 });

    res.json({
      success: true,
      schedules: schedules.map(schedule => ({
        id: schedule._id,
        time: schedule.time.toISOString(),
        duration: schedule.duration,
        status: schedule.status
      }))
    });

  } catch (error) {
    console.error('❌ Get schedules error:', error);
    res.status(500).json({
      error: 'Failed to get schedules',
      details: error.message
    });
  }
});

app.post('/api/schedules', async (req, res) => {
  try {
    const { deviceId, time, duration } = req.body;

    if (!deviceId || !time || !duration) {
      return res.status(400).json({
        error: 'Device ID, time, and duration are required'
      });
    }

    const device = await Device.findOne({ deviceId });
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const schedule = new Schedule({
      deviceId,
      time: new Date(time),
      duration: parseInt(duration)
    });

    await schedule.save();

    // Schedule the job with Agenda
    await agenda.schedule(new Date(time), 'execute watering', {
      scheduleId: schedule._id.toString(),
      deviceId,
      duration: parseInt(duration)
    });

    res.json({
      success: true,
      message: 'Schedule created successfully',
      schedule: {
        id: schedule._id,
        deviceId: schedule.deviceId,
        time: schedule.time,
        duration: schedule.duration,
        status: schedule.status
      }
    });

  } catch (error) {
    console.error('❌ Create schedule error:', error);
    res.status(500).json({
      error: 'Failed to create schedule',
      details: error.message
    });
  }
});

// Agenda job definitions
agenda.define('execute watering', async (job) => {
  const { scheduleId, deviceId, duration } = job.attrs.data;
  
  try {
    console.log(`⏰ Executing scheduled watering for device ${deviceId} (${duration}ms)`);

    await Schedule.findByIdAndUpdate(scheduleId, {
      status: 'executed',
      executedAt: new Date()
    });

    const device = await Device.findOne({ deviceId });
    if (!device || device.status !== 'online') {
      console.log(`⚠️ Device ${deviceId} is offline, marking schedule as failed`);
      await Schedule.findByIdAndUpdate(scheduleId, {
        status: 'failed',
        lastError: 'Device offline'
      });
      return;
    }

    // Send watering command via WebSocket
    const sent = sendToDevice(deviceId, MESSAGE_TYPE.WATER_COMMAND, {
      action: 'water',
      duration,
      scheduleId,
      commandId: `schedule_${scheduleId}_${Date.now()}`
    });

    if (sent) {
      // Notify frontend
      broadcastToFrontends('schedule_executed', {
        deviceId,
        scheduleId,
        duration,
        timestamp: new Date()
      });
      
      console.log(`✅ Scheduled watering command sent to device ${deviceId}`);
    } else {
      await Schedule.findByIdAndUpdate(scheduleId, {
        status: 'failed',
        lastError: 'Device not connected'
      });
    }

  } catch (error) {
    console.error('❌ Scheduled watering execution error:', error);
    
    await Schedule.findByIdAndUpdate(scheduleId, {
      status: 'failed',
      lastError: error.message
    });
  }
});

// Start agenda
(async function() {
  await agenda.start();
  console.log('⏰ Agenda scheduler started');
})();

// Basic route
app.get('/', (req, res) => {
  res.json({
    message: '💧 Smart Watering System Backend (WebSocket)',
    status: 'running',
    timestamp: new Date().toISOString(),
    wsEndpoint: '/ws'
  });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🛑 Shutting down gracefully...');
  await agenda.stop();
  await mongoose.connection.close();
  wss.close(() => {
    server.close(() => {
      console.log('✅ Server shut down complete');
      process.exit(0);
    });
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 WebSocket server ready at /ws`);
  console.log(`🌐 Backend URL: http://localhost:${PORT}`);
});

module.exports = { app, wss, agenda };