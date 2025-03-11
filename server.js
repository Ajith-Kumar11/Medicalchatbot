require('dotenv').config();

const express = require('express');
const path = require('path');
const { Sequelize, DataTypes } = require('sequelize');
const bcrypt = require('bcrypt');
const session = require('express-session');
const helmet = require('helmet');
const { v4: uuidv4 } = require('uuid');
const dialogflow = require('@google-cloud/dialogflow');

// Initialize Express app
const app = express();
const sessionContexts = new Map();

// Constants
const CURRENT_DATE = new Date('2025-03-03T13:09:08Z');
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
    logging: false
});

// Models
const User = sequelize.define('User', {
    username: {
        type: DataTypes.STRING,
        allowNull: false
    },
    email: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
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
    description: DataTypes.TEXT,
    status: {
        type: DataTypes.STRING,
        defaultValue: 'scheduled'
    }
});

// Sync database
sequelize.sync().catch(error => {
    console.error('Database sync error:', error);
});

// Global middleware
app.use((req, res, next) => {
    res.locals.username = req.session.username || null;
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

// Dialogflow setup
let dialogflowInitialized = false;
let sessionClient = null;

async function initializeDialogflow() {
    try {
        const projectId = process.env.DIALOGFLOW_PROJECT_ID || 'medicalchatbot-452314';
        console.log('Initializing Dialogflow with project ID:', projectId);

        sessionClient = new dialogflow.SessionsClient({
            keyFilename: path.join(__dirname, 'config', 'dialogflow-service-account.json'),
            projectId: projectId
        });

        const testSessionPath = sessionClient.projectAgentSessionPath(projectId, 'test-session');
        const testRequest = {
            session: testSessionPath,
            queryInput: {
                text: {
                    text: 'test',
                    languageCode: 'en-US'
                }
            }
        };

        await sessionClient.detectIntent(testRequest);
        dialogflowInitialized = true;
        console.log('✓ Dialogflow initialized successfully');
        return true;
    } catch (error) {
        console.error('✗ Dialogflow initialization failed:', error);
        dialogflowInitialized = false;
        return false;
    }
}

async function detectIntent(queryText, sessionId) {
    if (!dialogflowInitialized) {
        await initializeDialogflow();
    }

    if (!sessionClient) {
        throw new Error('Dialogflow client not initialized');
    }

    try {
        console.log('Detecting intent for:', queryText);
        const projectId = process.env.DIALOGFLOW_PROJECT_ID || 'medicalchatbot-452314';
        const sessionPath = sessionClient.projectAgentSessionPath(projectId, sessionId);
        
        const request = {
            session: sessionPath,
            queryInput: {
                text: {
                    text: queryText,
                    languageCode: 'en-US'
                }
            }
        };

        const [response] = await sessionClient.detectIntent(request);
        return response;
    } catch (error) {
        console.error('Dialogflow API error:', error);
        throw error;
    }
}

// Intent handlers
const intentHandlers = {
    'Default Welcome Intent': async () => ({
        reply: `Hello! I'm MedAssist, your medical assistant. How can I help you today?`,
        suggestions: ['Book Appointment', 'Check Symptoms', 'Medicine Information']
    }),

    'Check Symptoms': async (parameters, userId, context) => {
        const symptoms = parameters.fields?.symptoms?.stringValue;
        const bodyPart = parameters.fields?.bodyPart?.stringValue;
        const duration = parameters.fields?.duration?.stringValue;

        if (!symptoms) {
            return {
                reply: "What symptoms are you experiencing? Please describe them briefly.",
                suggestions: ["Headache", "Fever", "Cough", "Stomach Pain", "Fatigue"],
                expectingSymptom: true
            };
        }

        if (!bodyPart) {
            return {
                reply: `Which part of your body is affected by the ${symptoms}?`,
                suggestions: ["Head", "Chest", "Stomach", "Back", "Limbs"],
                expectingBodyPart: true,
                currentSymptoms: symptoms
            };
        }

        if (!duration) {
            return {
                reply: `How long have you been experiencing ${symptoms} in your ${bodyPart}?`,
                suggestions: ["Few hours", "1-2 days", "Several days", "More than a week"],
                expectingDuration: true,
                currentSymptoms: symptoms,
                currentBodyPart: bodyPart
            };
        }

        const severity = analyzeSymptomSeverity(symptoms, bodyPart, duration);
        const response = {
            reply: generateSymptomResponse(symptoms, bodyPart, duration, severity),
            suggestions: severity === 'high' 
                ? ["Book Emergency Appointment", "Find Nearest Hospital", "Call Emergency"]
                : severity === 'medium'
                ? ["Book Regular Appointment", "Get More Information", "Chat with Doctor"]
                : ["Self-Care Tips", "Book Appointment", "Monitor Symptoms"],
            severity,
            symptomDetails: { symptoms, bodyPart, duration }
        };

        return response;
    },

    'Appointment Booking': async (parameters, userId) => {
        try {
            const date = parameters.fields?.date?.stringValue;
            const time = parameters.fields?.time?.stringValue;

            if (!date && !time) {
                return {
                    reply: "When would you like to schedule your appointment?",
                    suggestions: ['Tomorrow', 'Next Monday', 'Next Week'],
                    expectingDate: true
                };
            }

            if (!date) {
                return {
                    reply: "What date would you like the appointment for?",
                    suggestions: ['Tomorrow', 'Next Monday', 'Next Week'],
                    expectingDate: true
                };
            }

            if (!isValidAppointmentDate(date)) {
                return {
                    reply: "Sorry, you can't book appointments for past dates. Please choose a future date.",
                    suggestions: ['Tomorrow', 'Next Week', 'Choose another date'],
                    expectingDate: true
                };
            }

            if (!time) {
                return {
                    reply: `What time would you prefer on ${date}?`,
                    suggestions: ['Morning (9 AM)', 'Afternoon (2 PM)', 'Evening (6 PM)'],
                    expectingTime: true,
                    selectedDate: date
                };
            }

            const appointment = await Appointment.create({
                userId,
                date,
                time,
                description: 'General consultation'
            });

            return {
                reply: `Great! I've booked your appointment for ${date} at ${time}.`,
                appointmentDetails: { date, time },
                suggestions: ['View appointment', 'Book another appointment', 'Thank you']
            };
        } catch (error) {
            console.error('Appointment booking error:', error);
            return {
                reply: 'Sorry, there was an error booking your appointment. Please try again.',
                error: true,
                suggestions: ['Try again', 'Book for another day', 'Talk to support']
            };
        }
    },

    'Default Fallback Intent': async () => ({
        reply: "I'm not sure I understand. Could you please rephrase that?",
        suggestions: ['Book Appointment', 'Check Symptoms', 'Emergency Help']
    })
};

// Helper functions
function analyzeSymptomSeverity(symptoms, bodyPart, duration) {
    const highRiskSymptoms = [
        'chest pain', 'difficulty breathing', 'severe headache',
        'stroke', 'heart attack', 'unconscious', 'severe bleeding'
    ];

    const mediumRiskSymptoms = [
        'fever', 'persistent cough', 'moderate pain',
        'vomiting', 'diarrhea'
    ];

    const symptomLower = symptoms.toLowerCase();

    if (highRiskSymptoms.some(s => symptomLower.includes(s))) {
        return 'high';
    }

    if (mediumRiskSymptoms.some(s => symptomLower.includes(s))) {
        return 'medium';
    }

    if (duration.toLowerCase().includes('week') || 
        duration.toLowerCase().includes('month')) {
        return 'medium';
    }

    return 'low';
}

function generateSymptomResponse(symptoms, bodyPart, duration, severity) {
    switch (severity) {
        case 'high':
            return `Based on your symptoms (${symptoms} in ${bodyPart} for ${duration}), this could be serious. I recommend immediate medical attention. Would you like me to help you find the nearest emergency room or schedule an urgent appointment?`;
        case 'medium':
            return `I understand you're experiencing ${symptoms} in your ${bodyPart} for ${duration}. While this doesn't appear to be immediately life-threatening, you should consult with a healthcare provider soon. Would you like to schedule an appointment?`;
        case 'low':
            return `I see you're having ${symptoms} in your ${bodyPart} for ${duration}. This seems mild, but it's good to monitor it. Here are some self-care tips, but if symptoms persist or worsen, please schedule an appointment.`;
        default:
            return `I understand you're experiencing ${symptoms} in your ${bodyPart} for ${duration}. Would you like to schedule an appointment to discuss this with a healthcare provider?`;
    }
}

function isValidAppointmentDate(date) {
    const appointmentDate = new Date(date);
    const today = new Date(CURRENT_DATE);
    today.setHours(0, 0, 0, 0);
    return appointmentDate >= today;
}

// Routes
app.get('/', (req, res) => {
    res.render('index', { 
        title: 'HealthAssist - Medical Chatbot Service',
        username: req.session.username || null
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
            order: [['date', 'ASC']]
        });
        res.render('dashboard', {
            title: 'Dashboard - HealthAssist',
            username: req.session.username,
            appointments
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
        currentDate: CURRENT_DATE.toISOString().replace('T', ' ').slice(0, 19),
        currentUser: CURRENT_USER
    });
});

app.post('/chat', isAuthenticated, async (req, res) => {
    const { message } = req.body;
    const userId = req.session.userId;

    if (!message) {
        return res.status(400).json({ 
            reply: "Please enter a message",
            suggestions: ['Book Appointment', 'Check Symptoms', 'Medical Information']
        });
    }

    try {
        console.log('Processing chat message:', { userId, message });

        const userContext = sessionContexts.get(userId) || {};
        const sessionId = userContext.sessionId || `user-${userId}-${uuidv4()}`;

        const response = await detectIntent(message, sessionId);
        const result = response.queryResult;

        console.log('Dialogflow Result:', {
            intent: result.intent?.displayName,
            confidence: result.intentDetectionConfidence
        });

        let chatResponse;

        if (message.toLowerCase() === 'check symptoms') {
            chatResponse = {
                reply: "What symptoms are you experiencing? Please describe them briefly.",
                suggestions: ["Headache", "Fever", "Cough", "Stomach Pain", "Fatigue"],
                expectingSymptom: true
            };
            userContext.expectingSymptom = true;
        }
        else if (userContext.expectingSymptom) {
            chatResponse = {
                reply: `Which part of your body is affected by the ${message}?`,
                suggestions: ["Head", "Chest", "Stomach", "Back", "Limbs"],
                expectingBodyPart: true,
                currentSymptoms: message
            };
            userContext.symptoms = message;
            userContext.expectingSymptom = false;
            userContext.expectingBodyPart = true;
        }
        else if (userContext.expectingBodyPart) {
            chatResponse = {
                reply: `How long have you been experiencing ${userContext.symptoms} in your ${message}?`,
                suggestions: ["Few hours", "1-2 days", "Several days", "More than a week"],
                expectingDuration: true,
                currentSymptoms: userContext.symptoms,
                currentBodyPart: message
            };
            userContext.bodyPart = message;
            userContext.expectingBodyPart = false;
            userContext.expectingDuration = true;
        }
        else if (userContext.expectingDuration) {
            const symptoms = userContext.symptoms;
            const bodyPart = userContext.bodyPart;
            const duration = message;
            
            const severity = analyzeSymptomSeverity(symptoms, bodyPart, duration);
            chatResponse = {
                reply: generateSymptomResponse(symptoms, bodyPart, duration, severity),
                suggestions: severity === 'high' 
                    ? ["Book Emergency Appointment", "Find Nearest Hospital", "Call Emergency"]
                    : severity === 'medium'
                    ? ["Book Regular Appointment", "Get More Information", "Chat with Doctor"]
                    : ["Self-Care Tips", "Book Appointment", "Monitor Symptoms"],
                severity: severity,
                symptomDetails: { symptoms, bodyPart, duration }
            };
            delete userContext.expectingDuration;
            delete userContext.symptoms;
            delete userContext.bodyPart;
        }
        else if (result.intent?.displayName) {
            const intentName = result.intent.displayName;
            const intentHandler = intentHandlers[intentName];
            if (intentHandler) {
                chatResponse = await intentHandler(result.parameters, userId, userContext);
                chatResponse.intent = intentName;
                chatResponse.confidence = result.intentDetectionConfidence;
            } else {
                chatResponse = {
                    reply: "I'm not sure how to handle that request. Could you please rephrase?",
                    suggestions: ['Book Appointment', 'Check Symptoms', 'Medical Information']
                };
            }
        }
        else {
            chatResponse = {
                reply: result.fulfillmentText || "I'm sorry, I didn't understand that. Could you please rephrase?",
                suggestions: ['Book Appointment', 'Check Symptoms', 'Medical Information']
            };
        }

        sessionContexts.set(userId, {
            ...userContext,
            sessionId,
            lastIntent: result.intent?.displayName,
            lastMessage: message,
            timestamp: new Date('2025-03-03T13:12:23Z').toISOString()
        });

        chatResponse.timestamp = new Date('2025-03-03T13:12:23Z').toISOString();
        res.json(chatResponse);

    } catch (error) {
        console.error('Chat error:', error);
        res.status(500).json({
            reply: "I'm sorry, but I encountered an error. Please try again.",
            suggestions: ['Book Appointment', 'Check Symptoms', 'Emergency Help']
        });
    }
});

// Error handling
app.use((req, res) => {
    res.status(404).render('error', {
        title: '404 - Not Found',
        message: 'The page you are looking for does not exist.'
    });
});

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).render('error', {
        title: 'Server Error',
        message: 'Something went wrong!'
    });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    
    // Format current date and time
    const now = new Date('2025-03-03T13:12:23Z');
    const formattedDate = now.toISOString().slice(0, 19).replace('T', ' ');
    
    console.log(`Current Date and Time (UTC - YYYY-MM-DD HH:MM:SS formatted): ${formattedDate}`);
    console.log(`Current User's Login: Ajith-Kumar11`);
    
    try {
        await sequelize.authenticate();
        console.log('Database connection established successfully.');
        
        const initialized = await initializeDialogflow();
        console.log('Dialogflow initialization:', initialized ? 'successful' : 'failed');
        if (!initialized) {
            console.error('Warning: Chatbot service may not be available');
        }
    } catch (error) {
        console.error('Error during startup:', error);
    }
});

module.exports = app;