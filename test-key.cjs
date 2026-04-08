const WebSocket = require('ws'); 
const apiKey = process.env.GEMINI_API_KEY; 

// The default Gemini Live API endpoint
const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;

const ws = new WebSocket(url);

ws.on('open', () => {
    console.log('✅ WebSocket connection successful!');
    ws.close();
});

ws.on('error', (err) => {
    console.error('❌ WebSocket error:', err.message);
});

ws.on('unexpected-response', (request, response) => {
    console.error(`❌ Unexpected response: ${response.statusCode}`);
});

//test that we can actually connect to the Gemini Live API using the provided API key
ws.on('close', (code, reason) => {
    if (code === 1000) {
        console.log('✅ WebSocket connection closed successfully.');
    } else {
        console.error(`❌ WebSocket connection closed with code ${code} and reason: ${reason}`);
    }
});