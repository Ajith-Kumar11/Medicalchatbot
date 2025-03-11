require('dotenv').config();
const dialogflow = require('@google-cloud/dialogflow');
const path = require('path');

async function testChatSystem() {
    console.log('Testing Chat System...\n');
    
    try {
        // 1. Test environment variables
        console.log('1. Checking environment variables:');
        console.log('Project ID:', process.env.DIALOGFLOW_PROJECT_ID);
        console.log('Credentials path:', process.env.GOOGLE_APPLICATION_CREDENTIALS);

        // 2. Test Dialogflow connection
        console.log('\n2. Testing Dialogflow connection:');
        const sessionClient = new dialogflow.SessionsClient({
            keyFilename: path.join(__dirname, 'config', 'dialogflow-service-account.json'),
            projectId: process.env.DIALOGFLOW_PROJECT_ID
        });
        console.log('SessionClient created successfully');

        // 3. Test basic conversation
        console.log('\n3. Testing conversation flow:');
        const testMessages = ['hi', 'I need to see a doctor', 'I have a headache'];
        
        for (const message of testMessages) {
            console.log(`\nTesting message: "${message}"`);
            
            const sessionPath = sessionClient.projectAgentSessionPath(
                process.env.DIALOGFLOW_PROJECT_ID,
                `test-${Date.now()}`
            );

            const request = {
                session: sessionPath,
                queryInput: {
                    text: {
                        text: message,
                        languageCode: 'en-US',
                    },
                },
            };

            const [response] = await sessionClient.detectIntent(request);
            console.log('Response:', {
                intent: response.queryResult.intent?.displayName,
                reply: response.queryResult.fulfillmentText,
                confidence: response.queryResult.intentDetectionConfidence
            });
        }

        console.log('\nTest completed successfully!');
        
    } catch (error) {
        console.error('Test failed:', error);
    }
}

testChatSystem();