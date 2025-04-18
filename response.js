require('dotenv').config();
const dialogflow = require('@google-cloud/dialogflow');
const path = require('path');

async function testDialogflowResponse() {
    console.log('Testing Dialogflow Response...');
    
    try {
        const sessionClient = new dialogflow.SessionsClient({
            keyFilename: path.join(__dirname, 'config', 'dialogflow-service-account'.json'),
            projectId: process.env.DIALOGFLOW_PROJECT_ID
        });

        console.log('Testing greetings...');
        const testCases = ['hi', 'hello', 'book appointment', 'I have a headache'];

        for (const text of testCases) {
            const sessionId = 'test-session-' + Date.now();
            const sessionPath = sessionClient.projectAgentSessionPath(
                process.env.DIALOGFLOW_PROJECT_ID,
                sessionId
            );

            const request = {
                session: sessionPath,
                queryInput: {
                    text: {
                        text: text,
                        languageCode: 'en-US',

                    },
                },
            };

            console.log(`\nTesting phrase: "${text}"`);
            const [response] = await sessionClient.detectIntent(request);
            console.log('Intent:', response.queryResult.intent?.displayName);
            console.log('Response:', response.queryResult.fulfillmentText);
            console.log('Confidence:', response.queryResult.intentDetectionConfidence);
        }
    } catch (error) {
        console.error('Test failed:', error);
    }
}

testDialogflowResponse();