require('dotenv').config();

const express = require('express');
const path = require('path');
const { Sequelize, DataTypes } = require('sequelize');
const bcrypt = require('bcrypt');
const session = require('express-session');
const helmet = require('helmet');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const RASA_API_URL = process.env.RASA_API_URL || 'http://localhost:5005';

// Initialize Express app
const app = express();
const sessionContexts = new Map();

// Constants
const CURRENT_DATE = new Date('2025-03-13T15:17:01Z');
const CURRENT_USER = 'Ajith-Kumar11';

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false,
}));

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Database setup
const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: 'database.sqlite',
    logging: false,
    pool: {
        max: 5,
        min: 0,
        acquire: 30000,
        idle: 10000
    }
});

// Models
const User = sequelize.define('User', {
    username: {
        type: DataTypes.STRING,
        allowNull: false,
        validate: {
            len: [3, 50]
        }
    },
    email: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
        validate: {
            isEmail: true
        }
    },
    password: {
        type: DataTypes.STRING,
        allowNull: false
    }
});

const Appointment = sequelize.define('Appointment', {
    userId: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    date: {
        type: DataTypes.DATEONLY,
        allowNull: false
    },
    time: {
        type: DataTypes.TIME,
        allowNull: false
    },
    description: {
        type: DataTypes.TEXT,
        defaultValue: 'General consultation'
    },
    status: {
        type: DataTypes.STRING,
        defaultValue: 'scheduled',
        validate: {
            isIn: [['scheduled', 'completed', 'cancelled']]
        }
    }
});

// Define the initializeDatabase function
async function initializeDatabase() {
    try {
        // Change force: true to alter: true to preserve data
        await sequelize.sync({ alter: true });
        
        // Check if admin user exists, if not create one
        const adminUser = await User.findOne({ where: { email: 'admin@example.com' } });
        if (!adminUser) {
            const hashedPassword = await bcrypt.hash('admin123', 10);
            await User.create({
                username: 'admin',
                email: 'admin@example.com',
                password: hashedPassword
            });
            console.log('✓ Default admin user created');
        }
        
        console.log('✓ Database schema synchronized.');
    } catch (error) {
        console.error('✗ Error synchronizing database schema:', error);
    }
}

// Global middleware
app.use((req, res, next) => {
    res.locals.username = req.session.username || null;
    res.locals.currentDate = CURRENT_DATE;
    next();
});

// Auth middleware
const isAuthenticated = (req, res, next) => {
    if (req.session.userId) {
        next();
    } else {
        res.redirect('/login');
    }
};

// Rasa Integration
let rasaInitialized = false;

async function initializeRasa() {
    try {
        const response = await axios.get(`${RASA_API_URL}/status`);
        if (response.status === 200) {
            rasaInitialized = true;
            console.log('✓ Rasa server initialized successfully');
            return true;
        }
        throw new Error('Rasa server not responding');
    } catch (error) {
        console.error('✗ Rasa initialization failed:', error.message);
        rasaInitialized = false;
        return false;
    }
}

async function sendMessageToRasa(message, senderId) {
    if (!rasaInitialized) {
        throw new Error('Rasa not initialized');
    }

    try {
        const response = await axios.post(`${RASA_API_URL}/webhooks/rest/webhook`, {
            sender: senderId,
            message: message
        });

        const firstResponse = response.data[0] || {};
        return {
            text: firstResponse.text || "Sorry, I couldn't process that.",
            buttons: firstResponse.buttons || [],
            custom: firstResponse.custom || {}
        };
    } catch (error) {
        console.error('Error communicating with Rasa:', error);
        throw error;
    }
}

// Utility functions
function sanitizeInput(input) {
    return input.trim().replace(/[<>]/g, '');
}

function validateDate(date) {
    const inputDate = new Date(date);
    return inputDate instanceof Date && !isNaN(inputDate);
}

function formatDateTime(date) {
    return new Date(date).toLocaleString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function parseDate(dateString) {
    const date = new Date(dateString);
    return isNaN(date) ? null : date;
}

function parseTime(timeString) {
    // Simple time parser for common formats
    const timeRegex = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;
    const match = timeString.match(timeRegex);
    
    if (!match) return null;
    
    let hours = parseInt(match[1]);
    const minutes = parseInt(match[2] || '0');
    const meridian = match[3]?.toLowerCase();
    
    if (meridian === 'pm' && hours < 12) hours += 12;
    if (meridian === 'am' && hours === 12) hours = 0;
    
    if (hours < 9 || hours > 18) return null; // Only allow appointments between 9 AM and 6 PM
    
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:00`;
}

function formatDate(date) {
    return date.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
}

function formatTime(time) {
    return new Date(`2000-01-01T${time}`).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    });
}

function isValidAppointmentDate(date) {
    const now = new Date();
    return date > now;
}

function analyzeSymptomSeverity(symptoms, location, duration) {
    // Simple severity analysis
    const severityKeywords = {
        high: ['severe', 'intense', 'extreme', 'unbearable'],
        medium: ['moderate', 'uncomfortable', 'concerning'],
        low: ['mild', 'slight', 'minor']
    };

    // Default to medium severity if can't determine
    return 'medium';
}

function getSeverityBasedSuggestions(severity) {
    const suggestions = {
        high: ['Call Emergency', 'Find Nearest ER', 'Call Doctor Now'],
        medium: ['Book Appointment', 'Consult Doctor', 'Monitor Symptoms'],
        low: ['Monitor Symptoms', 'Home Care Tips', 'Book Appointment']
    };

    return suggestions[severity] || suggestions.medium;
}

function generateSymptomResponse(symptoms, location, duration, severity) {
    const responses = {
        high: `Based on your description of ${symptoms} in the ${location} for ${duration}, this could be serious. Please seek immediate medical attention.`,
        medium: `Your ${symptoms} in the ${location} lasting ${duration} should be evaluated by a healthcare provider. Would you like to schedule an appointment?`,
        low: `The ${symptoms} you're experiencing in your ${location} for ${duration} seems mild. Monitor your symptoms and rest. If they persist or worsen, please schedule an appointment.`
    };

    return responses[severity] || responses.medium;
}

// Intent handlers
const intentHandlers = {
    'Default Welcome Intent': async () => ({
        reply: `Hello! I'm MedAssist, your medical assistant. How can I help you today?`,
        suggestions: ['Check Symptoms', 'Book Appointment', 'Emergency Help']
    }),

    'Check Symptoms': async (parameters, userId, context) => {
        const symptoms = parameters.fields?.symptoms?.stringValue;
        const bodyPart = parameters.fields?.bodyPart?.stringValue;
        const duration = parameters.fields?.duration?.stringValue;

        // Initialize symptom assessment
        if (!context.symptomAssessment) {
            context.symptomAssessment = {
                stage: 'initial',
                data: {}
            };
        }

        const assessment = context.symptomAssessment;

        switch (assessment.stage) {
            case 'initial':
                assessment.stage = 'gathering_symptoms';
                return {
                    reply: "What symptoms are you experiencing? Please describe them briefly.",
                    suggestions: ["Headache", "Fever", "Cough", "Chest Pain", "Shortness of Breath"],
                    expectingSymptom: true
                };

            case 'gathering_symptoms':
                assessment.data.symptoms = symptoms || context.lastMessage;
                assessment.stage = 'gathering_location';
                return {
                    reply: `Where exactly are you experiencing ${assessment.data.symptoms}?`,
                    suggestions: ["Head", "Chest", "Abdomen", "Arms", "Legs", "Back"],
                    expectingLocation: true
                };

            case 'gathering_location':
                assessment.data.location = bodyPart || context.lastMessage;
                assessment.stage = 'gathering_duration';
                return {
                    reply: `How long have you been experiencing these symptoms?`,
                    suggestions: ["Few hours", "1-2 days", "Several days", "More than a week"],
                    expectingDuration: true
                };

            case 'gathering_duration':
                assessment.data.duration = duration || context.lastMessage;
                const severity = analyzeSymptomSeverity(
                    assessment.data.symptoms,
                    assessment.data.location,
                    assessment.data.duration
                );
                
                // Reset assessment
                context.symptomAssessment = null;

                return {
                    reply: generateSymptomResponse(
                        assessment.data.symptoms,
                        assessment.data.location,
                        assessment.data.duration,
                        severity
                    ),
                    suggestions: getSeverityBasedSuggestions(severity),
                    severity: severity,
                    symptomDetails: assessment.data
                };
        }
    },

    'Appointment Booking': async (parameters, userId, context) => {
        const date = parameters.fields?.date?.stringValue;
        const time = parameters.fields?.time?.stringValue;

        if (!context.appointmentBooking) {
            context.appointmentBooking = {
                stage: 'initial',
                data: {}
            };
        }

        const booking = context.appointmentBooking;

        switch (booking.stage) {
            case 'initial':
                booking.stage = 'gathering_date';
                return {
                    reply: "When would you like to schedule your appointment?",
                    suggestions: ['Tomorrow', 'Next Week', 'Next Month'],
                    expectingDate: true
                };

            case 'gathering_date':
                const parsedDate = parseDate(date || context.lastMessage);
                if (!parsedDate || !isValidAppointmentDate(parsedDate)) {
                    return {
                        reply: "I'm sorry, that date isn't available. Please choose a future date.",
                        suggestions: ['Tomorrow', 'Next Week', 'Next Month'],
                        expectingDate: true
                    };
                }

                booking.data.date = parsedDate;
                booking.stage = 'gathering_time';
                return {
                    reply: `What time would you prefer on ${formatDate(parsedDate)}?`,
                    suggestions: ['Morning (9 AM)', 'Afternoon (2 PM)', 'Evening (5 PM)'],
                    expectingTime: true
                };

            case 'gathering_time':
                const parsedTime = parseTime(time || context.lastMessage);
                if (!parsedTime) {
                    return {
                        reply: "Please select a valid time between 9 AM and 6 PM.",
                        suggestions: ['Morning (9 AM)', 'Afternoon (2 PM)', 'Evening (5 PM)'],
                        expectingTime: true
                    };
                }

                try {
                    const appointment = await Appointment.create({
                        userId,
                        date: booking.data.date,
                        time: parsedTime,
                        description: booking.data.reason || 'General consultation',
                        type: booking.data.type || 'regular'
                    });

                    // Reset booking context
                    context.appointmentBooking = null;

                    return {
                        reply: `Great! Your appointment is confirmed for ${formatDate(booking.data.date)} at ${formatTime(parsedTime)}.`,
                        suggestions: ['View Appointment', 'Book Another', 'Thank You'],
                        appointmentDetails: appointment
                    };
                } catch (error) {
                    console.error('Appointment booking error:', error);
                    return {
                        reply: "I'm sorry, there was an error booking your appointment. Please try again.",
                        suggestions: ['Try Again', 'Different Time', 'Contact Support']
                    };
                }
        }
    },

    'Emergency Help': async () => ({
        reply: "If you're experiencing a medical emergency, please call emergency services immediately (911). Do you need help locating the nearest emergency room?",
        suggestions: ['Find Nearest ER', 'Call Emergency', 'Not Emergency'],
        type: 'emergency'
    }),

    'Default Fallback Intent': async () => ({
        reply: "I'm not sure I understand. Could you please rephrase that?",
        suggestions: ['Check Symptoms', 'Book Appointment', 'Emergency Help']
    })
};

// Routes
app.get('/', (req, res) => {
    res.render('index', { 
        title: 'HealthAssist - Medical Chatbot Service',
        username: req.session.username || null,
        currentDate: new Date("2025-03-14T01:29:22Z").toISOString()
    });
});

app.get('/login', (req, res) => {
    if (req.session.userId) {
        return res.redirect('/dashboard');
    }
    res.render('login', { 
        title: 'Login - HealthAssist',
        error: null 
    });
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const user = await User.findOne({ where: { email } });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.render('login', {
                title: 'Login - HealthAssist',
                error: 'Invalid email or password'
            });
        }

        req.session.userId = user.id;
        req.session.username = user.username;
        res.redirect('/dashboard');
    } catch (error) {
        console.error('Login error:', error);
        res.render('login', {
            title: 'Login - HealthAssist',
            error: 'An error occurred during login'
        });
    }
});

app.get('/signup', (req, res) => {
    if (req.session.userId) {
        return res.redirect('/dashboard');
    }
    res.render('signup', { 
        title: 'Sign Up - HealthAssist',
        error: null 
    });
});

app.post('/signup', async (req, res) => {
    const { username, email, password } = req.body;

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        await User.create({
            username,
            email,
            password: hashedPassword
        });
        res.redirect('/login');
    } catch (error) {
        console.error('Signup error:', error);
        res.render('signup', {
            title: 'Sign Up - HealthAssist',
            error: 'An error occurred during signup'
        });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

app.get('/dashboard', isAuthenticated, async (req, res) => {
    try {
        const appointments = await Appointment.findAll({
            where: { userId: req.session.userId },
            order: [['date', 'ASC'], ['time', 'ASC']]
        });
        
        res.render('dashboard', {
            title: 'Dashboard - HealthAssist',
            username: req.session.username,
            appointments,
            currentDate: CURRENT_DATE
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.render('error', {
            title: 'Error',
            message: 'Error loading dashboard'
        });
    }
});

app.get('/chat', isAuthenticated, (req, res) => {
    res.render('chat', {
        title: 'Chat - HealthAssist',
        username: req.session.username,
        currentDate: CURRENT_DATE.toISOString().slice(0, 19).replace('T', ' '),
        currentUser: CURRENT_USER
    });
});

// Chat route handler
app.post('/chat', isAuthenticated, async (req, res) => {
    const { message } = req.body;
    const userId = req.session.userId;

    if (!message?.trim()) {
        return res.status(400).json({ 
            reply: "Please enter a message",
            suggestions: ['Check Symptoms', 'Book Appointment', 'Emergency Help']
        });
    }

    try {
        const sanitizedMessage = sanitizeInput(message);
        const userContext = sessionContexts.get(userId) || {
            sessionId: `user-${userId}-${uuidv4()}`,
            conversationHistory: []
        };

        // Add message to history
        userContext.conversationHistory.push({
            role: 'user',
            content: sanitizedMessage,
            timestamp: new Date().toISOString()
        });

        // Get Rasa response
        const rasaResponse = await sendMessageToRasa(sanitizedMessage, userContext.sessionId);

        // Handle appointment booking if indicated by Rasa
        if (rasaResponse.custom?.intent === 'book_appointment') {
            try {
                const appointment = await Appointment.create({
                    userId,
                    date: rasaResponse.custom.date,
                    time: rasaResponse.custom.time,
                    description: rasaResponse.custom.description || 'General consultation',
                    status: 'scheduled'
                });
                rasaResponse.appointmentDetails = appointment;
            } catch (error) {
                console.error('Appointment booking error:', error);
                rasaResponse.error = 'Failed to book appointment';
            }
        }

        // Update context
        userContext.lastMessage = sanitizedMessage;
        userContext.lastTimestamp = new Date().toISOString();
        sessionContexts.set(userId, userContext);

        // Add response to history
        userContext.conversationHistory.push({
            role: 'bot',
            content: rasaResponse.text,
            timestamp: new Date().toISOString()
        });

        res.json({
            reply: rasaResponse.text,
            suggestions: rasaResponse.buttons.map(btn => btn.title) || 
                        ['Check Symptoms', 'Book Appointment', 'Emergency Help'],
            custom: rasaResponse.custom,
            appointmentDetails: rasaResponse.appointmentDetails
        });

    } catch (error) {
        console.error('Chat error:', error);
        res.status(500).json({
            reply: "I apologize, but I'm having trouble processing your request. Please try again.",
            suggestions: ['Try Again', 'Book Appointment', 'Emergency Help']
        });
    }
});

// 404 handler - this should be after all other routes
app.use((req, res) => {
    res.status(404).render('error', {
        title: '404 - Not Found',
        message: 'The page you are looking for does not exist.'
    });
});

// Error handlers
app.use((err, req, res, next) => {
    console.error(err.stack);
    const statusCode = err.statusCode || 500;
    const message = process.env.NODE_ENV === 'production' 
        ? 'An error occurred. Please try again later.' 
        : err.message;
    
    res.status(statusCode).json({
        error: {
            message,
            status: statusCode
        }
    });
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    if (process.env.NODE_ENV === 'production') {
        process.exit(1);
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    
    try {
        await sequelize.authenticate();
        console.log('Database connection established successfully.');
        
        // Initialize database (only in development)
        if (process.env.NODE_ENV !== 'production') {
            await initializeDatabase();
        }
        
        // Initialize Rasa
        const initialized = await initializeRasa();
        if (!initialized) {
            console.warn('Warning: Rasa chatbot service may not be available');
        }
    } catch (error) {
        console.error('Error during startup:', error);
    }
});

module.exports = app;