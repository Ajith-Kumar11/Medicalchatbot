require('dotenv').config();

const express = require('express');
const path = require('path');
const { Sequelize, DataTypes } = require('sequelize');
const bcrypt = require('bcrypt');
const session = require('express-session');
const helmet = require('helmet');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

// Rasa configuration
const RASA_API_URL = process.env.RASA_API_URL || 'http://localhost:5005';
const RASA_WEBHOOK_ENDPOINT = '/webhooks/rest/webhook';
const RASA_STATUS_ENDPOINT = '/status';
const RASA_MAX_RETRIES = 5;
const RASA_RETRY_DELAY = 3000; // 3 seconds

// Initialize Express app
const app = express();
const sessionContexts = new Map();

// Constants
const CURRENT_DATE = new Date('2025-05-26T16:45:04Z'); // Updated to user's current date
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

// Chat history model to store conversations
const ChatMessage = sequelize.define('ChatMessage', {
    userId: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    isBot: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    },
    message: {
        type: DataTypes.TEXT,
        allowNull: false
    },
    timestamp: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
    },
    sessionId: {
        type: DataTypes.STRING
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
    res.locals.rasaStatus = global.rasaStatus || 'unknown';
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
let rasaStatus = 'unavailable';

// Advanced Rasa initialization with retry mechanism
async function initializeRasa() {
    console.log('Initializing Rasa server connection...');
    
    for (let attempt = 1; attempt <= RASA_MAX_RETRIES; attempt++) {
        try {
            console.log(`Rasa connection attempt ${attempt} of ${RASA_MAX_RETRIES}...`);
            
            const response = await axios.get(`${RASA_API_URL}${RASA_STATUS_ENDPOINT}`, {
                timeout: 5000 // 5 second timeout
            });
            
            if (response.status === 200) {
                rasaInitialized = true;
                rasaStatus = 'available';
                global.rasaStatus = 'available';
                
                console.log('✓ Rasa server initialized successfully!');
                console.log(`✓ Rasa server status: ${JSON.stringify(response.data)}`);
                
                // Start a heartbeat to monitor Rasa status
                startRasaHeartbeat();
                return true;
            }
            throw new Error(`Rasa server responded with status: ${response.status}`);
        } catch (error) {
            console.error(`✗ Rasa initialization attempt ${attempt} failed:`, 
                error.code || error.response?.status || error.message);
            
            if (attempt === RASA_MAX_RETRIES) {
                rasaStatus = 'unavailable';
                global.rasaStatus = 'unavailable';
                console.error('✗ Maximum retry attempts reached. Rasa initialization failed.');
                break;
            }
            
            // Exponential backoff for retries
            const delay = RASA_RETRY_DELAY * Math.pow(1.5, attempt - 1);
            console.log(`Waiting ${delay}ms before retrying...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    
    setupFallbackChatbot();
    return false;
}

// Maintain Rasa connection with heartbeat
function startRasaHeartbeat() {
    const HEARTBEAT_INTERVAL = 60000; // 1 minute
    
    setInterval(async () => {
        try {
            const response = await axios.get(`${RASA_API_URL}${RASA_STATUS_ENDPOINT}`, {
                timeout: 3000
            });
            
            if (response.status === 200) {
                if (!rasaInitialized) {
                    console.log('✓ Rasa server reconnected');
                    rasaInitialized = true;
                    rasaStatus = 'available';
                    global.rasaStatus = 'available';
                }
            } else {
                throw new Error(`Rasa responded with status: ${response.status}`);
            }
        } catch (error) {
            if (rasaInitialized) {
                console.error('✗ Lost connection to Rasa server:', 
                    error.code || error.response?.status || error.message);
                rasaInitialized = false;
                rasaStatus = 'unavailable';
                global.rasaStatus = 'unavailable';
            }
        }
    }, HEARTBEAT_INTERVAL);
}

// Setup a fallback chatbot for when Rasa is unavailable
function setupFallbackChatbot() {
    console.log('Setting up fallback chatbot system...');
    // We'll use the fallback responses when Rasa is unavailable
}

// FIXED: Improved sendMessageToRasa function for better handling of responses
async function sendMessageToRasa(message, senderId) {
    if (!rasaInitialized) {
        return useFallbackChatResponse(message, senderId);
    }

    try {
        // Direct intent mapping for common phrases that should trigger intents
        const directIntentMap = {
            'book appointment': '/book_appointment',
            'schedule appointment': '/book_appointment',
            'make appointment': '/book_appointment',
            'i need to book an appointment': '/book_appointment',
            'check symptoms': '/check_symptoms',
            'i am feeling': '/check_symptoms',
            'i feel': '/check_symptoms',
            'i have pain': '/check_symptoms',
            'i have a headache': '/check_symptoms',
            'what is flu': '/ask_disease_info{"condition":"flu"}',
            'what is influenza': '/ask_disease_info{"condition":"flu"}',
            'tell me about flu': '/ask_disease_info{"condition":"flu"}',
            'what is hypertension': '/ask_disease_info{"condition":"hypertension"}',
            'what is high blood pressure': '/ask_disease_info{"condition":"hypertension"}',
        };
        
        // Convert message to lowercase for better matching
        const lowerMessage = message.toLowerCase().trim();
        
        // Check if this message is a direct intent match
        let payload = message;
        for (const [key, intent] of Object.entries(directIntentMap)) {
            if (lowerMessage === key || lowerMessage.startsWith(key)) {
                payload = intent;
                console.log(`Direct intent match: "${message}" -> "${intent}"`);
                break;
            }
        }

        console.log(`Sending message to Rasa: "${message}" from user ${senderId}`);
        
        // Prepare the request payload - sending either the original message or an intent payload
        const requestData = {
            sender: senderId,
            message: payload
        };

        // Send the request with increased timeout
        const response = await axios.post(`${RASA_API_URL}${RASA_WEBHOOK_ENDPOINT}`, requestData, {
            timeout: 15000  // 15 second timeout for complex queries
        });

        // Handle empty or null responses with intelligent fallbacks
        if (!response.data || response.data.length === 0) {
            console.warn(`Received empty response from Rasa for message: "${message}"`);
            
            // Provide intelligent fallbacks based on the message content
            if (lowerMessage.includes('appointment')) {
                return {
                    text: "I'd be happy to help you book an appointment. When would you like to schedule it?",
                    buttons: [
                        { title: "Today", payload: "/provide_appointment_date{\"date\":\"today\"}" },
                        { title: "Tomorrow", payload: "/provide_appointment_date{\"date\":\"tomorrow\"}" },
                        { title: "Next Week", payload: "/provide_appointment_date{\"date\":\"next week\"}" }
                    ]
                };
            }
            
            if (lowerMessage.includes('symptom') || 
                lowerMessage.includes('feeling') || 
                lowerMessage.includes('pain') ||
                lowerMessage.includes('headache') ||
                lowerMessage.includes('dizzy')) {
                return {
                    text: "I'm sorry to hear you're not feeling well. Could you tell me more about your symptoms? When did they start and how severe are they?",
                    buttons: [
                        { title: "Describe Symptoms", payload: "/check_symptoms" },
                        { title: "Book Appointment", payload: "/book_appointment" },
                        { title: "Emergency Help", payload: "/emergency_help" }
                    ]
                };
            }
            
            // Specific handler for "what is flu" type queries
            if (lowerMessage.includes('flu') || lowerMessage.includes('influenza')) {
                return {
                    text: "Influenza (flu) is a contagious respiratory illness caused by influenza viruses. Symptoms typically include fever, cough, sore throat, muscle aches, and fatigue. The flu can range from mild to severe and sometimes lead to complications. Annual vaccination is the best way to prevent flu infections.",
                    buttons: [
                        { title: "Flu Prevention", payload: "/ask_prevention_info{\"condition\":\"flu\"}" },
                        { title: "Flu Symptoms", payload: "/ask_disease_info{\"condition\":\"flu\",\"aspect\":\"symptoms\"}" },
                        { title: "Flu Treatment", payload: "/ask_disease_info{\"condition\":\"flu\",\"aspect\":\"treatment\"}" }
                    ]
                };
            }
            
            return {
                text: "I understand you're asking about something important. Could you please provide a bit more detail so I can help you better?",
                buttons: [
                    { title: "Check Symptoms", payload: "/check_symptoms" },
                    { title: "Book Appointment", payload: "/book_appointment" },
                    { title: "Health Information", payload: "/ask_health_question" }
                ]
            };
        }

        const responses = response.data;
        let combinedText = "";
        let allButtons = [];
        let custom = {};

        // Process all responses and combine them
        responses.forEach(resp => {
            // Only add non-empty and non-fallback responses to the combinedText
            if (resp.text && 
                !resp.text.includes("I'm processing your request...") &&
                !resp.text.includes("I didn't catch that") && 
                !resp.text.includes("I'm not sure I follow")) {
                combinedText += resp.text + " ";
            }
            
            if (resp.buttons) allButtons = [...allButtons, ...resp.buttons];
            if (resp.custom) custom = { ...custom, ...resp.custom };
        });

        // If we still don't have a good response text after filtering, use a fallback
        if (!combinedText.trim()) {
            // Try to infer the intent from the message for better fallbacks
            if (lowerMessage.includes('flu') || lowerMessage.includes('influenza')) {
                combinedText = "Influenza (flu) is a contagious respiratory illness caused by influenza viruses. Symptoms include fever, cough, sore throat, muscle aches, and fatigue. The flu can range from mild to severe and sometimes lead to complications requiring hospitalization. Annual vaccination is the best way to prevent flu infections.";
            } 
            else if (lowerMessage.includes('dizzy') || lowerMessage.includes('dizziness')) {
                combinedText = "Dizziness can be caused by various factors including inner ear problems, low blood pressure, dehydration, medication side effects, or more serious conditions. If you're experiencing dizziness, it's important to stay hydrated, avoid sudden movements, and sit or lie down to prevent falls. If dizziness persists or is severe, please consult a healthcare provider.";
            }
            else if (lowerMessage.includes('appointment') || lowerMessage.includes('book') || lowerMessage.includes('schedule')) {
                combinedText = "I'd be happy to help you book an appointment. When would you like to schedule it?";
                
                if (!allButtons.length) {
                    allButtons = [
                        { title: "Today", payload: "/provide_appointment_date{\"date\":\"today\"}" },
                        { title: "Tomorrow", payload: "/provide_appointment_date{\"date\":\"tomorrow\"}" },
                        { title: "Next Week", payload: "/provide_appointment_date{\"date\":\"next week\"}" }
                    ];
                }
            }
            else if (lowerMessage === 'check symptoms' || lowerMessage.includes('check my symptoms')) {
                combinedText = "I'd be happy to help assess your symptoms. Could you please tell me what symptoms you're experiencing?";
                
                if (!allButtons.length) {
                    allButtons = [
                        { title: "Headache", payload: "/provide_symptom{\"symptom\":\"headache\"}" },
                        { title: "Fever", payload: "/provide_symptom{\"symptom\":\"fever\"}" },
                        { title: "Cough", payload: "/provide_symptom{\"symptom\":\"cough\"}" }
                    ];
                }
            }
            else {
                // Use the first response text regardless of content if we have nothing better
                combinedText = responses[0]?.text || "I'm not sure how to respond to that. Could you try rephrasing your question?";
            }
        }

        console.log(`Received response from Rasa: "${combinedText}"`);

        return {
            text: combinedText.trim(),
            buttons: allButtons,
            custom: custom
        };
    } catch (error) {
        console.error('Error communicating with Rasa:', error.message);
        
        if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
            // Connection issues - mark Rasa as unavailable
            if (rasaInitialized) {
                console.log('✗ Lost connection to Rasa server during message processing');
                rasaInitialized = false;
                rasaStatus = 'unavailable';
                global.rasaStatus = 'unavailable';
                
                // Try to reconnect on next request
                setTimeout(() => initializeRasa(), 5000);
            }
        }
        
        return useFallbackChatResponse(message, senderId);
    }
}

// Improved fallback responses with health-specific information
function useFallbackChatResponse(message, senderId) {
    console.log('Using fallback response for message:', message);
    
    const lowercaseMessage = message.toLowerCase();
    
    // Improved handling for symptoms and medical conditions
    if (lowercaseMessage.includes('dizzy') || lowercaseMessage.includes('dizziness')) {
        return {
            text: "Dizziness can be caused by various factors including inner ear problems, low blood pressure, dehydration, medication side effects, or more serious conditions. If you're experiencing persistent or severe dizziness, please consult a healthcare provider.",
            buttons: [
                { title: "Book Appointment", payload: "/book_appointment" },
                { title: "Emergency Help", payload: "/emergency_help" }
            ],
            custom: { intent: "symptom_info" }
        };
    }
    
    if (lowercaseMessage.includes('appointment') || 
        lowercaseMessage.includes('book') || 
        lowercaseMessage.includes('schedule')) {
        
        return {
            text: "I'd be happy to help you book an appointment. When would you like to schedule it?",
            buttons: [
                { title: "Today", payload: "/provide_appointment_date{\"date\":\"today\"}" },
                { title: "Tomorrow", payload: "/provide_appointment_date{\"date\":\"tomorrow\"}" },
                { title: "Next Week", payload: "/provide_appointment_date{\"date\":\"next week\"}" }
            ],
            custom: { intent: "fallback_appointment" }
        };
    }
    
    if (lowercaseMessage.includes('symptom') || 
        lowercaseMessage.includes('pain') || 
        lowercaseMessage.includes('hurt') ||
        lowercaseMessage.includes('feel')) {
        
        return {
            text: "I notice you might be describing symptoms. Could you tell me more about what you're experiencing? When did your symptoms start and how severe are they?",
            buttons: [
                { title: "Describe Symptoms", payload: "/check_symptoms" },
                { title: "Book Appointment", payload: "/book_appointment" },
                { title: "Emergency Help", payload: "/emergency_help" }
            ],
            custom: { intent: "fallback_symptoms" }
        };
    }
    
    if (lowercaseMessage.includes('flu') || lowercaseMessage.includes('influenza')) {
        return {
            text: "Influenza (flu) is a contagious respiratory illness caused by influenza viruses. Symptoms include fever, cough, sore throat, muscle aches, and fatigue. The flu can range from mild to severe and sometimes lead to complications requiring hospitalization. Annual vaccination is the best way to prevent flu infections.",
            buttons: [
                { title: "Flu Prevention", payload: "/ask_prevention_info{\"condition\":\"flu\"}" },
                { title: "Flu Treatment", payload: "/ask_disease_info{\"condition\":\"flu\",\"aspect\":\"treatment\"}" }
            ],
            custom: { intent: "disease_info" }
        };
    }
    
    if (lowercaseMessage.includes('emergency') || 
        lowercaseMessage.includes('urgent') || 
        lowercaseMessage.includes('911')) {
        
        return {
            text: "If you're experiencing a medical emergency, please call emergency services (911) immediately. Don't wait for an online response.",
            buttons: [
                { title: "Find ER Near Me", payload: "/find_emergency_room" }
            ],
            custom: { intent: "emergency" }
        };
    }
    
    // Default fallback
    return {
        text: "I'm not sure I understand. I can help with symptom assessment, appointment booking, or providing health information. How can I assist you today?",
        buttons: [
            { title: "Check Symptoms", payload: "/check_symptoms" },
            { title: "Book Appointment", payload: "/book_appointment" },
            { title: "Health Information", payload: "/ask_health_question" }
        ],
        custom: { intent: "fallback_default" }
    };
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

// Routes
app.get('/', (req, res) => {
    res.render('index', { 
        title: 'HealthAssist - Medical Chatbot Service',
        username: req.session.username || null,
        currentDate: new Date("2025-05-26T16:45:04Z").toISOString(), // Updated to user's time
        rasaStatus
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

app.get('/chat', isAuthenticated, async (req, res) => {
    // Get user's previous chat history
    try {
        const chatHistory = await ChatMessage.findAll({
            where: { userId: req.session.userId },
            order: [['timestamp', 'ASC']],
            limit: 50
        });

        res.render('chat', {
            title: 'Chat - HealthAssist',
            username: req.session.username,
            currentDate: CURRENT_DATE.toISOString().slice(0, 19).replace('T', ' '),
            currentUser: CURRENT_USER,
            chatHistory: chatHistory || [],
            rasaStatus
        });
    } catch (error) {
        console.error('Error loading chat history:', error);
        res.render('chat', {
            title: 'Chat - HealthAssist',
            username: req.session.username,
            currentDate: CURRENT_DATE.toISOString().slice(0, 19).replace('T', ' '),
            currentUser: CURRENT_USER,
            chatHistory: [],
            rasaStatus
        });
    }
});

// Improved chat route handler with better fallbacks
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

        // Save user message to database
        await ChatMessage.create({
            userId,
            message: sanitizedMessage,
            isBot: false,
            timestamp: new Date(),
            sessionId: userContext.sessionId
        });

        // Add message to in-memory history
        userContext.conversationHistory.push({
            role: 'user',
            content: sanitizedMessage,
            timestamp: new Date().toISOString()
        });

        // Get Rasa response with improved error handling and fallbacks
        console.log(`Sending message to Rasa: "${sanitizedMessage}" from user ${userId}`);
        const rasaResponse = await sendMessageToRasa(sanitizedMessage, userContext.sessionId);
        console.log(`Received response from Rasa: "${rasaResponse.text}"`);

        // Special handling for empty or placeholder responses
        let finalResponse = { ...rasaResponse };

        // Fix placeholder responses - these are issues in your Rasa responses
        if (finalResponse.text.includes('[SURGERY_INFO_PLACEHOLDER]')) {
            if (sanitizedMessage.toLowerCase().includes('dizzy')) {
                finalResponse.text = "Dizziness can have many causes including inner ear problems, medication side effects, or blood pressure issues. If you're experiencing dizziness, it's important to rest and avoid sudden movements. If symptoms persist or are severe, you should consult a healthcare provider.";
            }
        }

        // Handle appointment booking if indicated by Rasa
        if (finalResponse.text.toLowerCase().includes('appointment') && 
            (finalResponse.text.toLowerCase().includes('schedule') || 
             finalResponse.text.toLowerCase().includes('book'))) {
            
            if (!finalResponse.buttons || finalResponse.buttons.length === 0) {
                finalResponse.buttons = [
                    { title: "Today", payload: "/provide_appointment_date{\"date\":\"today\"}" },
                    { title: "Tomorrow", payload: "/provide_appointment_date{\"date\":\"tomorrow\"}" },
                    { title: "Next Week", payload: "/provide_appointment_date{\"date\":\"next week\"}" }
                ];
            }
        }

        // Save bot response to database
        await ChatMessage.create({
            userId,
            message: finalResponse.text,
            isBot: true,
            timestamp: new Date(),
            sessionId: userContext.sessionId
        });

        // Update context
        userContext.lastMessage = sanitizedMessage;
        userContext.lastTimestamp = new Date().toISOString();
        sessionContexts.set(userId, userContext);

        // Add response to history
        userContext.conversationHistory.push({
            role: 'bot',
            content: finalResponse.text,
            timestamp: new Date().toISOString()
        });

        res.json({
            reply: finalResponse.text,
            suggestions: finalResponse.buttons?.map(btn => btn.title) || 
                        ['Check Symptoms', 'Book Appointment', 'Health Information'],
            custom: finalResponse.custom,
            appointmentDetails: finalResponse.appointmentDetails
        });

    } catch (error) {
        console.error('Chat error:', error);
        
        // Create a fallback response
        const fallbackResponse = {
            reply: "I apologize, but I'm having trouble processing your request. Please try again.",
            suggestions: ['Try Again', 'Book Appointment', 'Emergency Help']
        };
        
        // Save fallback response
        try {
            await ChatMessage.create({
                userId,
                message: fallbackResponse.reply,
                isBot: true,
                timestamp: new Date(),
                sessionId: `user-${userId}-fallback`
            });
        } catch (dbError) {
            console.error('Error saving fallback response to database:', dbError);
        }
        
        res.status(500).json(fallbackResponse);
    }
});

// Status endpoint - can be used for monitoring
app.get('/api/status', (req, res) => {
    res.json({
        server: 'running',
        rasaStatus,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Reset Rasa connection route (admin only)
app.post('/api/admin/reset-rasa', isAuthenticated, async (req, res) => {
    // In a real app, you'd check if user is admin
    try {
        console.log('Manual Rasa reconnection requested');
        const initialized = await initializeRasa();
        
        res.json({
            success: initialized,
            message: initialized 
                ? 'Rasa connection re-established' 
                : 'Failed to connect to Rasa',
            rasaStatus
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error resetting Rasa connection',
            error: error.message
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

// Start server with proper initialization sequence
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, async () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    
    try {
        // First connect to database
        await sequelize.authenticate();
        console.log('Database connection established successfully.');
        
        // Then initialize database schema
        if (process.env.NODE_ENV !== 'production') {
            await initializeDatabase();
        }
        
        // Finally try to connect to Rasa
        console.log('Initializing Rasa...');
        const initialized = await initializeRasa();
        
        if (!initialized) {
            console.warn('Warning: Rasa chatbot service may not be available');
            console.warn('The application will use fallback responses for chat features.');
            console.warn('To fix this:');
            console.warn('1. Make sure Rasa server is running with: rasa run --enable-api --cors "*"');
            console.warn('2. Verify RASA_API_URL environment variable (default: http://localhost:5005)');
            console.warn('3. Restart this server after Rasa is running');
        }
    } catch (error) {
        console.error('Error during startup:', error);
    }
});

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('Received SIGINT. Shutting down gracefully...');
    server.close(() => {
        console.log('Closed out remaining connections.');
        process.exit(0);
    });
    
    // Force close after 10 seconds
    setTimeout(() => {
        console.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
    }, 10000);
});

module.exports = app;