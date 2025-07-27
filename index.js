const express = require('express');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const http = require('http');
const cors = require('cors');
const Agenda = require('agenda');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// UPDATED Socket.IO configuration for ESP8266 compatibility
const io = require('socket.io')(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  allowUpgrades: true
  // REMOVE the others!
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Environment variables
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/watering_system';

// MongoDB Connection with better error handling
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
})
.then(() => console.log('✅ Connected to MongoDB'))
.catch(err => console.error('❌ MongoDB connection error:', err));

// Handle MongoDB disconnection
mongoose.connection.on('disconnected', () => {
  console.log('⚠️ MongoDB disconnected');
});

mongoose.connection.on('reconnected', () => {
  console.log('✅ MongoDB reconnected');
});

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
  socketId: String,
  connectionAttempts: {
    type: Number,
    default: 0
  },
  lastConnectionError: String,
  engineIOVersion: String, // Track which EIO version device is using
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
  frontendConnections: 0,
  eio3Connections: 0,
  eio4Connections: 0
};

// Enhanced Socket.IO connection handling with ESP8266 support
io.on('connection', (socket) => {
  connectionStats.totalConnections++;
  connectionStats.activeConnections++;
  
  // Detect Engine.IO version
  const eioVersion = socket.handshake.query.EIO || socket.conn.protocol;
  console.log(`🔌 Socket client connected: ${socket.id} (EIO: ${eioVersion}, Active: ${connectionStats.activeConnections})`);
  
  // Track EIO version stats
  if (eioVersion === '3') {
    connectionStats.eio3Connections++;
  } else if (eioVersion === '4') {
    connectionStats.eio4Connections++;
  }
  
  // Send connection acknowledgment with compatibility info
  socket.emit('connected', { 
    status: 'connected', 
    socketId: socket.id,
    timestamp: new Date().toISOString(),
    serverVersion: '2.0',
    engineIOVersion: eioVersion,
    pingInterval: 25000,
    pingTimeout: 60000,
    compatibility: {
      eio3Supported: true,
      eio4Supported: true
    }
  });

  // Enhanced device joining with ESP8266 compatibility
  socket.on('join-device', async (deviceId) => {
    try {
      if (!deviceId) {
        socket.emit('join-error', { error: 'Device ID is required' });
        return;
      }

      console.log(`📱 Device ${deviceId} joining room with socket ${socket.id} (EIO: ${eioVersion})`);
      
      // Leave any existing rooms first
      socket.rooms.forEach(room => {
        if (room.startsWith('device-') && room !== socket.id) {
          socket.leave(room);
        }
      });
      
      // Join new device room
      socket.join(`device-${deviceId}`);
      
      // Check if device was already connected with different socket
      const existingConnection = connectedDevices.get(deviceId);
      if (existingConnection && existingConnection.socketId !== socket.id) {
        console.log(`⚠️ Device ${deviceId} reconnecting with new socket (old: ${existingConnection.socketId}, new: ${socket.id})`);
        // Disconnect old socket if still connected
        const oldSocket = io.sockets.sockets.get(existingConnection.socketId);
        if (oldSocket) {
          oldSocket.disconnect(true);
        }
      }
      
      // Store device connection info
      connectedDevices.set(deviceId, {
        socketId: socket.id,
        joinedAt: new Date(),
        lastSeen: new Date(),
        engineIOVersion: eioVersion,
        reconnectCount: existingConnection ? (existingConnection.reconnectCount || 0) + 1 : 0
      });
      
      connectionStats.deviceConnections++;
      
      // Update device status in database
      const updateResult = await Device.findOneAndUpdate(
        { deviceId },
        { 
          status: 'online',
          lastSeen: new Date(),
          socketId: socket.id,
          connectionAttempts: 0,
          lastConnectionError: null,
          engineIOVersion: eioVersion
        },
        { 
          upsert: true,
          new: true,
          runValidators: true
        }
      );
      
      console.log(`✅ Device ${deviceId} successfully joined and updated in database (EIO: ${eioVersion})`);
      
      // Send confirmation back to device with compatibility info
      socket.emit('device-joined', { 
        deviceId, 
        status: 'success',
        message: 'Successfully joined device room',
        reconnectCount: connectedDevices.get(deviceId).reconnectCount,
        engineIOVersion: eioVersion,
        serverCompatibility: {
          eio3: true,
          eio4: true
        },
        timestamp: new Date().toISOString()
      });
      
      // Notify all frontend clients about device connection
      socket.broadcast.to('frontend').emit('device-connected', {
        deviceId,
        status: 'online',
        engineIOVersion: eioVersion,
        timestamp: new Date().toISOString(),
        socketId: socket.id
      });
      
    } catch (error) {
      console.error(`❌ Error handling device join for ${deviceId}:`, error);
      
      // Update connection attempt count
      try {
        await Device.findOneAndUpdate(
          { deviceId },
          { 
            $inc: { connectionAttempts: 1 },
            lastConnectionError: error.message,
            lastSeen: new Date()
          }
        );
      } catch (dbError) {
        console.error('❌ Failed to update connection error in DB:', dbError);
      }
      
      socket.emit('join-error', { 
        error: 'Failed to join device room',
        details: error.message,
        deviceId,
        suggestion: 'Try different Engine.IO version or connection method'
      });
    }
  });

  // Handle pump status updates with validation
  socket.on('pump-status', async (data) => {
    try {
      if (!data || !data.deviceId || !data.status) {
        socket.emit('status-error', { error: 'Invalid pump status data' });
        return;
      }

      console.log('💧 Pump status update:', data);
      
      // Validate status value
      const validStatuses = ['idle', 'running', 'stopped', 'error'];
      if (!validStatuses.includes(data.status)) {
        socket.emit('status-error', { error: 'Invalid pump status value' });
        return;
      }
      
      // Update device pump status with error handling
      const updateData = { 
        pumpStatus: data.status === 'stopped' ? 'idle' : data.status,
        lastSeen: new Date()
      };
      
      const device = await Device.findOneAndUpdate(
        { deviceId: data.deviceId },
        updateData,
        { new: true }
      );
      
      if (!device) {
        console.warn(`⚠️ Pump status update for unknown device: ${data.deviceId}`);
        socket.emit('status-error', { error: 'Device not found' });
        return;
      }
      
      // Update connection tracking
      const connection = connectedDevices.get(data.deviceId);
      if (connection) {
        connection.lastSeen = new Date();
      }
      
      // Enhanced status data for broadcasting
      const statusUpdate = {
        ...data,
        timestamp: new Date().toISOString(),
        deviceStatus: device.status,
        lastSeen: device.lastSeen
      };
      
      // Broadcast to frontend clients with acknowledgment
      socket.broadcast.to('frontend').emit('pump-status-update', statusUpdate);
      
      // Send acknowledgment back to device
      socket.emit('status-received', { 
        deviceId: data.deviceId,
        status: 'acknowledged',
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('❌ Error handling pump status update:', error);
      socket.emit('status-error', { 
        error: 'Failed to process status update',
        details: error.message
      });
    }
  });

  // Enhanced frontend client handling
  socket.on('join-frontend', async () => {
    try {
      console.log('🖥️ Frontend client joined');
      socket.join('frontend');
      
      connectedFrontends.set(socket.id, {
        joinedAt: new Date(),
        lastActivity: new Date()
      });
      
      connectionStats.frontendConnections++;
      
      // Send current system status to new frontend client
      const devices = await Device.find().lean();
      const activeSchedules = await Schedule.find({ 
        status: 'pending',
        time: { $gte: new Date() }
      }).lean();
      
      socket.emit('frontend-joined', {
        status: 'success',
        timestamp: new Date().toISOString(),
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
          lastSeen: d.lastSeen,
          socketId: d.socketId,
          engineIOVersion: d.engineIOVersion
        }))
      });
      
    } catch (error) {
      console.error('❌ Error handling frontend join:', error);
      socket.emit('join-error', { 
        error: 'Failed to join frontend',
        details: error.message
      });
    }
  });

  // Handle heartbeat/ping from devices with ESP8266 compatibility
  socket.on('heartbeat', async (data) => {
    try {
      if (data && data.deviceId) {
        const connection = connectedDevices.get(data.deviceId);
        if (connection) {
          connection.lastSeen = new Date();
        }
        
        // Update device last seen in database
        await Device.findOneAndUpdate(
          { deviceId: data.deviceId },
          { lastSeen: new Date() }
        );
        
        // Send heartbeat acknowledgment
        socket.emit('heartbeat-ack', { 
          timestamp: new Date().toISOString(),
          serverTime: Date.now()
        });
      }
    } catch (error) {
      console.error('❌ Error handling heartbeat:', error);
    }
  });

  // Handle schedule execution acknowledgment
  socket.on('schedule-executed', async (data) => {
    try {
      if (data && data.scheduleId && data.deviceId) {
        console.log(`✅ Schedule execution confirmed by device ${data.deviceId}: ${data.scheduleId}`);
        
        // Update schedule status
        await Schedule.findByIdAndUpdate(data.scheduleId, {
          status: 'executed',
          executedAt: new Date()
        });
        
        // Notify frontend
        socket.broadcast.to('frontend').emit('schedule-execution-confirmed', {
          deviceId: data.deviceId,
          scheduleId: data.scheduleId,
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      console.error('❌ Error handling schedule execution confirmation:', error);
    }
  });

  // Handle command acknowledgments
  socket.on('command-ack', async (data) => {
    try {
      if (data && data.commandId && data.deviceId) {
        console.log(`✅ Command acknowledged by device ${data.deviceId}: ${data.commandId}`);
        
        // Notify frontend
        socket.broadcast.to('frontend').emit('command-acknowledged', {
          deviceId: data.deviceId,
          commandId: data.commandId,
          status: data.status,
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      console.error('❌ Error handling command acknowledgment:', error);
    }
  });

  // Handle generic pong responses
  socket.on('pong', (data) => {
    if (data && data.deviceId) {
      const connection = connectedDevices.get(data.deviceId);
      if (connection) {
        connection.lastSeen = new Date();
      }
    }
  });

  // Enhanced disconnect handling
  socket.on('disconnect', async (reason) => {
    connectionStats.activeConnections--;
    
    // Update EIO version stats
    if (eioVersion === '3') {
      connectionStats.eio3Connections--;
    } else if (eioVersion === '4') {
      connectionStats.eio4Connections--;
    }
    
    console.log(`❌ Socket client disconnected: ${socket.id} (Reason: ${reason}, EIO: ${eioVersion})`);
    
    try {
      // Handle device disconnection
      for (let [deviceId, connectionInfo] of connectedDevices.entries()) {
        if (connectionInfo.socketId === socket.id) {
          console.log(`📱 Device ${deviceId} disconnected (EIO: ${eioVersion})`);
          
          connectedDevices.delete(deviceId);
          connectionStats.deviceConnections--;
          
          // Update device status in database
          await Device.findOneAndUpdate(
            { deviceId },
            { 
              status: 'offline',
              pumpStatus: 'idle',
              socketId: null,
              lastSeen: new Date()
            }
          );
          
          // Notify frontend clients
          socket.broadcast.to('frontend').emit('device-disconnected', {
            deviceId,
            status: 'offline',
            reason,
            engineIOVersion: eioVersion,
            timestamp: new Date().toISOString()
          });
          
          break;
        }
      }
      
      // Handle frontend disconnection
      if (connectedFrontends.has(socket.id)) {
        connectedFrontends.delete(socket.id);
        connectionStats.frontendConnections--;
        console.log('🖥️ Frontend client disconnected');
      }
      
    } catch (error) {
      console.error('❌ Error handling disconnect:', error);
    }
  });

  // Handle connection errors
  socket.on('connect_error', (error) => {
    console.error(`❌ Connection error for ${socket.id}:`, error);
  });

  // Handle Socket.IO errors
  socket.on('error', (error) => {
    console.error(`❌ Socket error for ${socket.id}:`, error);
  });
});

// Connection monitoring and cleanup
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
            pumpStatus: 'idle',
            socketId: null
          }
        );
        
        // Notify frontends
        io.to('frontend').emit('device-disconnected', {
          deviceId,
          status: 'offline',
          reason: 'timeout',
          timestamp: now.toISOString()
        });
      }
    }
    
    // Cleanup frontend connections
    for (let [socketId, connectionInfo] of connectedFrontends.entries()) {
      if (connectionInfo.lastActivity < fiveMinutesAgo) {
        const socket = io.sockets.sockets.get(socketId);
        if (!socket || !socket.connected) {
          connectedFrontends.delete(socketId);
          connectionStats.frontendConnections--;
        }
      }
    }
    
  } catch (error) {
    console.error('❌ Error in connection cleanup:', error);
  }
}, 60000); // Run every minute

// API Routes with enhanced error handling
app.post('/api/devices/register', async (req, res) => {
  try {
    const { deviceId, ip, timestamp } = req.body;

    if (!deviceId) {
      return res.status(400).json({ error: 'Device ID is required' });
    }

    console.log(`📡 Device registration request: ${deviceId} from IP: ${ip}`);

    // Find existing device or create new one
    let device = await Device.findOne({ deviceId });

    if (device) {
      // Update existing device
      device.ip = ip;
      device.lastSeen = new Date();
      device.status = 'online';
      device.connectionAttempts = 0;
      device.lastConnectionError = null;
      await device.save();
      console.log(`🔄 Updated existing device: ${deviceId}`);
    } else {
      // Create new device
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
        lastSeen: device.lastSeen,
        connectionAttempts: device.connectionAttempts
      },
      serverInfo: {
        socketUrl: req.get('host'),
        timestamp: new Date().toISOString(),
        socketIOCompatibility: {
          eio3Supported: true,
          eio4Supported: true,
          transports: ['websocket', 'polling']
        }
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

// Enhanced manual water command with better error handling
app.post('/api/devices/:deviceId/water', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { action, duration } = req.body;

    if (!action) {
      return res.status(400).json({ error: 'Action is required' });
    }

    // Check if device exists and is online
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

    // Check if device is connected via socket
    const connection = connectedDevices.get(deviceId);
    if (!connection) {
      return res.status(409).json({ 
        error: 'Device is not connected via socket',
        suggestion: 'Device may need to reconnect'
      });
    }

    console.log(`💧 Manual water command for ${deviceId}: ${action} (${duration}ms)`);

    // Prepare command data
    const commandData = {
      action,
      duration: duration || 0,
      commandId: `cmd_${Date.now()}`,
      timestamp: new Date().toISOString()
    };

    // Send command to device via Socket.IO with timeout
    const deviceRoom = `device-${deviceId}`;
    const room = io.sockets.adapter.rooms[deviceRoom];
    const socketsInRoom = room ? Object.keys(room.sockets) : [];
    
    if (socketsInRoom.length === 0) {
      return res.status(409).json({ 
        error: 'No active socket connection for device',
        deviceId
      });
    }

    // Send to device
    io.to(deviceRoom).emit('water-command', commandData);
    
    // Also broadcast to frontend
    io.to('frontend').emit('manual-command', {
      deviceId,
      ...commandData
    });

    res.json({
      success: true,
      message: `Water command sent to device ${deviceId}`,
      command: commandData,
      activeConnections: socketsInRoom.length,
      deviceEngineIO: connection.engineIOVersion
    });

  } catch (error) {
    console.error('❌ Manual water command error:', error);
    res.status(500).json({
      error: 'Failed to send water command',
      details: error.message
    });
  }
});

// System status endpoint with EIO version info
app.get('/api/system/status', async (req, res) => {
  try {
    const devices = await Device.find().lean();
    const schedules = await Schedule.find({ status: 'pending' }).lean();
    
    res.json({
      success: true,
      systemStatus: {
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        connections: connectionStats,
        database: {
          connected: mongoose.connection.readyState === 1,
          totalDevices: devices.length,
          onlineDevices: devices.filter(d => d.status === 'online').length,
          pendingSchedules: schedules.length
        },
        memory: process.memoryUsage(),
        socketConnections: {
          total: io.engine.clientsCount,
          devices: connectedDevices.size,
          frontends: connectedFrontends.size
        },
        compatibility: {
          engineIOVersions: {
            v3Connections: connectionStats.eio3Connections,
            v4Connections: connectionStats.eio4Connections
          },
          supportedTransports: ['websocket', 'polling'],
          esp8266Compatible: true
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get system status',
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

// Get all devices
app.get('/api/devices', async (req, res) => {
  try {
    const devices = await Device.find().sort({ createdAt: -1 });
    res.json({
      success: true,
      devices
    });
  } catch (error) {
    console.error('❌ Get devices error:', error);
    res.status(500).json({
      error: 'Failed to get devices',
      details: error.message
    });
  }
});

// Get device schedules
app.get('/api/devices/:deviceId/schedules', async (req, res) => {
  try {
    const { deviceId } = req.params;
    
    // Get pending schedules for the device
    const schedules = await Schedule.find({
      deviceId,
      status: 'pending',
      time: { $gte: new Date() } // Only future schedules
    }).sort({ time: 1 });

    console.log(`📅 Fetched ${schedules.length} schedules for device: ${deviceId}`);

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

// Create new schedule
app.post('/api/schedules', async (req, res) => {
  try {
    const { deviceId, time, duration } = req.body;

    if (!deviceId || !time || !duration) {
      return res.status(400).json({
        error: 'Device ID, time, and duration are required'
      });
    }

    // Validate device exists
    const device = await Device.findOne({ deviceId });
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    // Create schedule
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

    console.log(`⏰ Created schedule for device ${deviceId} at ${time} for ${duration}ms`);

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

// Get all schedules
app.get('/api/schedules', async (req, res) => {
  try {
    const { deviceId, status } = req.query;
    
    let query = {};
    if (deviceId) query.deviceId = deviceId;
    if (status) query.status = status;

    const schedules = await Schedule.find(query).sort({ time: 1 });

    res.json({
      success: true,
      schedules
    });

  } catch (error) {
    console.error('❌ Get all schedules error:', error);
    res.status(500).json({
      error: 'Failed to get schedules',
      details: error.message
    });
  }
});

// Delete schedule
app.delete('/api/schedules/:scheduleId', async (req, res) => {
  try {
    const { scheduleId } = req.params;

    const schedule = await Schedule.findByIdAndDelete(scheduleId);
    
    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    // Cancel the agenda job
    await agenda.cancel({ 'data.scheduleId': scheduleId });

    res.json({
      success: true,
      message: 'Schedule deleted successfully'
    });

  } catch (error) {
    console.error('❌ Delete schedule error:', error);
    res.status(500).json({
      error: 'Failed to delete schedule',
      details: error.message
    });
  }
});

// Agenda job definitions
agenda.define('execute watering', async (job) => {
  const { scheduleId, deviceId, duration } = job.attrs.data;
  
  try {
    console.log(`⏰ Executing scheduled watering for device ${deviceId} (${duration}ms)`);

    // Update schedule status
    await Schedule.findByIdAndUpdate(scheduleId, {
      status: 'executed',
      executedAt: new Date()
    });

    // Check if device is online
    const device = await Device.findOne({ deviceId });
    if (!device || device.status !== 'online') {
      console.log(`⚠️ Device ${deviceId} is offline, marking schedule as failed`);
      await Schedule.findByIdAndUpdate(scheduleId, {
        status: 'failed',
        lastError: 'Device offline'
      });
      return;
    }

    // Send watering command to device
    io.to(`device-${deviceId}`).emit('water-command', {
      action: 'water',
      duration,
      scheduleId,
      commandId: `schedule_${scheduleId}_${Date.now()}`
    });

    // Notify frontend
    io.to('frontend').emit('schedule-executed', {
      deviceId,
      scheduleId,
      duration,
      timestamp: new Date()
    });

    console.log(`✅ Scheduled watering command sent to device ${deviceId}`);

  } catch (error) {
    console.error('❌ Scheduled watering execution error:', error);
    
    // Mark schedule as failed
    await Schedule.findByIdAndUpdate(scheduleId, {
      status: 'failed',
      lastError: error.message
    });
  }
});

// Clean up expired schedules (run every hour)
agenda.define('cleanup expired schedules', async (job) => {
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const result = await Schedule.updateMany(
      {
        status: 'pending',
        time: { $lt: oneDayAgo }
      },
      { status: 'expired' }
    );

    console.log(`🧹 Marked ${result.modifiedCount} expired schedules`);

  } catch (error) {
    console.error('❌ Cleanup expired schedules error:', error);
  }
});

// Start agenda
(async function() {
  await agenda.start();
  console.log('⏰ Agenda scheduler started');
  
  // Schedule cleanup job to run every hour
  await agenda.every('1 hour', 'cleanup expired schedules');
})();

// Basic route for health check
app.get('/', (req, res) => {
  res.json({
    message: '💧 Smart Watering System Backend',
    status: 'running',
    timestamp: new Date().toISOString(),
    compatibility: {
      esp8266: true,
      engineIO: ['v3', 'v4'],
      transports: ['websocket', 'polling']
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    details: err.message
  });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🛑 Shutting down gracefully...');
  await agenda.stop();
  await mongoose.connection.close();
  server.close(() => {
    console.log('✅ Server shut down complete');
    process.exit(0);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Socket.IO server ready with ESP8266 compatibility`);
  console.log(`🌐 Backend URL: http://localhost:${PORT}`);
  console.log(`🔧 Engine.IO v3 support: ENABLED`);
  console.log(`🔧 Engine.IO v4 support: ENABLED`);
});

module.exports = { app, io, agenda };