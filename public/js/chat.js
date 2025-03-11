<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title><%= title %> | Medical Chatbot</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css" rel="stylesheet">
    <style>
        .chat-container {
            max-width: 800px;
            margin: 20px auto;
            padding: 20px;
        }

        .chat-box {
            height: 400px;
            border: 1px solid #ddd;
            border-radius: 5px;
            padding: 15px;
            overflow-y: auto;
            margin-bottom: 20px;
            background: #f8f9fa;
        }

        .message {
            margin-bottom: 15px;
            padding: 10px;
            border-radius: 10px;
            max-width: 70%;
        }

        .user-message {
            background-color: #007bff;
            color: white;
            margin-left: auto;
        }

        .bot-message {
            background-color: #e9ecef;
            color: black;
        }

        .suggestions {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            margin-top: 10px;
        }

        .suggestion-btn {
            padding: 5px 15px;
            border-radius: 15px;
            border: 1px solid #007bff;
            background: white;
            color: #007bff;
            cursor: pointer;
            transition: all 0.3s;
        }

        .suggestion-btn:hover {
            background: #007bff;
            color: white;
        }

        #message-input {
            border-radius: 20px;
            padding: 10px 20px;
        }

        #send-button {
            border-radius: 20px;
        }
    </style>
</head>
<body>
    <nav class="navbar navbar-expand-lg navbar-light bg-light">
        <div class="container">
            <a class="navbar-brand" href="/">Medical Chatbot</a>
            <div class="navbar-nav ms-auto">
                <% if (locals.username) { %>
                    <span class="nav-link">Welcome, <%= username %></span>
                    <a class="nav-link" href="/dashboard">Dashboard</a>
                    <a class="nav-link" href="/logout">Logout</a>
                <% } %>
            </div>
        </div>
    </nav>

    <div class="chat-container">
        <div class="chat-box" id="chat-box"></div>
        
        <form id="chat-form" class="input-group">
            <input type="text" id="message-input" class="form-control" placeholder="Type your message here...">
            <button type="submit" id="send-button" class="btn btn-primary">Send</button>
        </form>
    </div>

    <script>
        const chatBox = document.getElementById('chat-box');
        const chatForm = document.getElementById('chat-form');
        const messageInput = document.getElementById('message-input');

        // Add initial bot message
        addBotMessage("Hello! How can I help you today?", ['Book Appointment', 'Check Symptoms', 'Emergency Help']);

        chatForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const message = messageInput.value.trim();
            if (!message) return;

            // Add user message to chat
            addUserMessage(message);
            messageInput.value = '';

            try {
                const response = await fetch('/chat', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ message })
                });

                const data = await response.json();
                addBotMessage(data.reply, data.suggestions);
            } catch (error) {
                console.error('Error:', error);
                addBotMessage("Sorry, there was an error. Please try again.", ['Book Appointment', 'Check Symptoms', 'Emergency Help']);
            }
        });

        function addUserMessage(message) {
            const messageDiv = document.createElement('div');
            messageDiv.className = 'message user-message';
            messageDiv.textContent = message;
            chatBox.appendChild(messageDiv);
            chatBox.scrollTop = chatBox.scrollHeight;
        }

        function addBotMessage(message, suggestions = []) {
            const messageDiv = document.createElement('div');
            messageDiv.className = 'message bot-message';
            messageDiv.textContent = message;

            if (suggestions.length > 0) {
                const suggestionsDiv = document.createElement('div');
                suggestionsDiv.className = 'suggestions';
                suggestions.forEach(suggestion => {
                    const button = document.createElement('button');
                    button.className = 'suggestion-btn';
                    button.textContent = suggestion;
                    button.onclick = () => {
                        messageInput.value = suggestion;
                        chatForm.dispatchEvent(new Event('submit'));
                    };
                    suggestionsDiv.appendChild(button);
                });
                messageDiv.appendChild(suggestionsDiv);
            }

            chatBox.appendChild(messageDiv);
            chatBox.scrollTop = chatBox.scrollHeight;
        }
    </script>
</body>
</html>