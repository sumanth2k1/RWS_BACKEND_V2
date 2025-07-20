const express = require('express');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const http = require('http');
const cors = require('cors');
const Agenda = require('agenda');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Environment variables
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/watering_system';

// MongoDB Connection
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// Initialize Agenda for job scheduling
const agenda = new Agenda({ db: { address: MONGODB_URI } });

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
  }
});

const Schedule = mongoose.model('Schedule', scheduleSchema);

// Socket.IO connection handling
const connectedDevices = new Map();

io.on('connection', (socket) => {
  console.log('🔌 Socket client connected:', socket.id);

  // Handle device joining their room
  socket.on('join-device', (deviceId) => {
    console.log(`📱 Device ${deviceId} joined room`);
    socket.join(`device-${deviceId}`);
    connectedDevices.set(deviceId, socket.id);
    
    // Update device status to online
    Device.findOneAndUpdate(
      { deviceId },
      { 
        status: 'online',
        lastSeen: new Date()
      }
    ).exec();
  });

  // Handle pump status updates from device
  socket.on('pump-status', (data) => {
    console.log('💧 Pump status update:', data);
    
    // Update device pump status
    Device.findOneAndUpdate(
      { deviceId: data.deviceId },
      { 
        pumpStatus: data.status,
        lastSeen: new Date()
      }
    ).exec();

    // Broadcast to frontend clients
    socket.broadcast.emit('pump-status-update', data);
  });

  // Handle frontend clients joining
  socket.on('join-frontend', () => {
    console.log('🖥️ Frontend client joined');
    socket.join('frontend');
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('❌ Socket client disconnected:', socket.id);
    
    // Find and update device status if it was a device connection
    for (let [deviceId, socketId] of connectedDevices.entries()) {
      if (socketId === socket.id) {
        connectedDevices.delete(deviceId);
        Device.findOneAndUpdate(
          { deviceId },
          { 
            status: 'offline',
            pumpStatus: 'idle'
          }
        ).exec();
        break;
      }
    }
  });
});

// API Routes

// Register device
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
        lastSeen: device.lastSeen
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

// Manual water command
app.post('/api/devices/:deviceId/water', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { action, duration } = req.body;

    if (!action) {
      return res.status(400).json({ error: 'Action is required' });
    }

    // Check if device is online
    const device = await Device.findOne({ deviceId });
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    console.log(`💧 Manual water command for ${deviceId}: ${action} (${duration}ms)`);

    // Send command to device via Socket.IO
    io.to(`device-${deviceId}`).emit('water-command', {
      action,
      duration: duration || 0
    });

    // Also broadcast to frontend
    io.to('frontend').emit('manual-command', {
      deviceId,
      action,
      duration,
      timestamp: new Date()
    });

    res.json({
      success: true,
      message: `Water command sent to device ${deviceId}`,
      command: { action, duration }
    });

  } catch (error) {
    console.error('❌ Manual water command error:', error);
    res.status(500).json({
      error: 'Failed to send water command',
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
        status: 'failed'
      });
      return;
    }

    // Send watering command to device
    io.to(`device-${deviceId}`).emit('water-command', {
      action: 'water',
      duration,
      scheduleId
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
      status: 'failed'
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
    timestamp: new Date().toISOString()
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
  console.log(`📡 Socket.IO server ready`);
  console.log(`🌐 Backend URL: http://localhost:${PORT}`);
});

module.exports = { app, io, agenda };