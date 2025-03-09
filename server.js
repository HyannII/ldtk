// server.js (with logging functionality)
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");

// Create express app and HTTP server
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Configure Express to handle larger payloads
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Serve static files
app.use(express.static("public"));

// Store connected clients
const clients = new Map();

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

// Logger function
function logEvent(eventType, data) {
  const timestamp = new Date().toISOString();
  const logFile = path.join(
    logsDir,
    `events_${new Date().toISOString().split("T")[0]}.log`
  );

  let logMessage = `[${timestamp}] [${eventType}] `;

  switch (eventType) {
    case "CONNECTION":
      logMessage += `Client ${data.clientId} connected from IP ${data.ipAddress}`;
      break;
    case "RECONNECTION":
      logMessage += `Client ${data.clientId} reconnected from IP ${data.ipAddress}`;
      break;
    case "DISCONNECTION":
      logMessage += `Client ${data.clientId} disconnected`;
      break;
    case "MESSAGE_SENT":
      logMessage += `Message sent to client ${data.clientId}, type: ${data.messageType}`;
      // For text messages, include content (but not for images due to size)
      if (data.messageType === "text") {
        logMessage += `, content: "${data.content}"`;
      } else if (data.messageType === "image") {
        // Just log that an image was sent, not the actual data URL
        logMessage += `, content: [IMAGE DATA]`;
      }
      break;
    case "CLIENT_REMOVED":
      logMessage += `Client ${data.clientId} removed after timeout`;
      break;
    case "ERROR":
      logMessage += `Error: ${data.message}`;
      if (data.clientId) {
        logMessage += ` (Client ${data.clientId})`;
      }
      break;
    default:
      logMessage += JSON.stringify(data);
  }

  // Write to log file
  fs.appendFile(logFile, logMessage + "\n", (err) => {
    if (err) {
      console.error("Error writing to log file:", err);
    }
  });

  // Also log to console
  console.log(logMessage);
}

// Create a function to generate client summary log
function generateClientSummary() {
  const logFile = path.join(
    logsDir,
    `client_summary_${new Date().toISOString().split("T")[0]}.log`
  );
  const timestamp = new Date().toISOString();
  let summaryContent = `[${timestamp}] ACTIVE CLIENTS SUMMARY\n`;
  summaryContent += "=".repeat(50) + "\n";

  if (clients.size === 0) {
    summaryContent += "No active clients.\n";
  } else {
    clients.forEach((client, clientId) => {
      summaryContent += `Client ID: ${clientId}\n`;
      summaryContent += `IP Address: ${client.ipAddress}\n`;
      summaryContent += `Status: ${client.status}\n`;
      summaryContent += `Connected at: ${client.connectedAt.toISOString()}\n`;
      summaryContent += `Last active: ${client.lastActive.toISOString()}\n`;
      summaryContent += "-".repeat(50) + "\n";
    });
  }

  fs.writeFile(logFile, summaryContent, (err) => {
    if (err) {
      console.error("Error writing client summary log:", err);
    }
  });
}

// Generate client summary every hour
setInterval(generateClientSummary, 3600000);

// Serve the sender interface
app.get("/sender", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "sender.html"));
});

// Serve the receiver interface
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "receiver.html"));
});

// Endpoint for sender to get all connected clients
app.get("/api/clients", (req, res) => {
  const clientList = [];
  clients.forEach((value, key) => {
    clientList.push({
      id: key,
      ipAddress: value.ipAddress,
      connectedAt: value.connectedAt,
      lastActive: value.lastActive,
      status: value.status,
    });
  });
  res.json(clientList);
});

// Endpoint for downloading logs
app.get("/api/logs", (req, res) => {
  fs.readdir(logsDir, (err, files) => {
    if (err) {
      logEvent("ERROR", { message: "Error reading logs directory" });
      return res.status(500).json({ error: "Error reading logs" });
    }

    res.json({ logs: files });
  });
});

app.get("/api/logs/:filename", (req, res) => {
  const logFile = path.join(logsDir, req.params.filename);

  // Security check - make sure we're not accessing files outside logs directory
  if (!logFile.startsWith(logsDir)) {
    return res.status(403).json({ error: "Access denied" });
  }

  fs.readFile(logFile, "utf8", (err, data) => {
    if (err) {
      logEvent("ERROR", {
        message: `Error reading log file: ${req.params.filename}`,
      });
      return res.status(404).json({ error: "Log file not found" });
    }

    res.set("Content-Type", "text/plain");
    res.send(data);
  });
});

// Endpoint for sending messages to a specific client
app.post("/api/send", (req, res) => {
  const { clientId, messageType, content } = req.body;

  if (!clients.has(clientId)) {
    logEvent("ERROR", { message: "Client not found", clientId });
    return res.status(404).json({ error: "Client not found" });
  }

  const client = clients.get(clientId);

  if (client.ws.readyState === WebSocket.OPEN) {
    const message = JSON.stringify({
      type: messageType,
      content: content,
      timestamp: new Date().toISOString(),
    });

    client.ws.send(message);
    client.lastActive = new Date();

    // Log the message sent (but avoid logging full image data)
    let logContent = content;
    if (messageType === "image") {
      // Just indicate an image was sent, don't log the actual data URL
      logContent = "[IMAGE DATA]";
    }

    logEvent("MESSAGE_SENT", {
      clientId,
      messageType,
      content: logContent,
    });

    return res.json({ success: true });
  } else {
    clients.delete(clientId);
    logEvent("ERROR", { message: "Client disconnected", clientId });
    return res.status(400).json({ error: "Client disconnected" });
  }
});

// WebSocket connection handler
wss.on("connection", (ws, req) => {
  // Parse URL parameters
  const url = new URL(req.url, `http://${req.headers.host}`);
  const existingClientId = url.searchParams.get("clientId");
  const ipAddress = req.socket.remoteAddress;
  let clientId;

  // Check if client is reconnecting with existing ID
  if (existingClientId && clients.has(existingClientId)) {
    // Update the existing client with new WebSocket connection
    clientId = existingClientId;
    const existingClient = clients.get(clientId);

    // Close old connection if it's still open
    if (existingClient.ws.readyState === WebSocket.OPEN) {
      existingClient.ws.close();
    }

    // Update client information
    clients.set(clientId, {
      ws: ws,
      ipAddress: ipAddress,
      connectedAt: existingClient.connectedAt, // Keep original connection time
      lastActive: new Date(),
      status: "online",
    });

    logEvent("RECONNECTION", { clientId, ipAddress });
  } else {
    // Generate a new client ID for new connections
    clientId = Date.now().toString();

    // Store client information
    clients.set(clientId, {
      ws: ws,
      ipAddress: ipAddress,
      connectedAt: new Date(),
      lastActive: new Date(),
      status: "online",
    });

    logEvent("CONNECTION", { clientId, ipAddress });
  }

  // Send client ID to the receiver
  ws.send(
    JSON.stringify({
      type: "connection",
      content: { clientId: clientId },
      timestamp: new Date().toISOString(),
    })
  );

  // Handle ping messages to keep track of connection status
  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === "ping") {
        if (clients.has(clientId)) {
          clients.get(clientId).lastActive = new Date();
          clients.get(clientId).status = "online";
        }
      }
    } catch (error) {
      logEvent("ERROR", {
        message: "Error parsing message",
        clientId,
        error: error.message,
      });
    }
  });

  // Handle disconnection
  ws.on("close", () => {
    if (clients.has(clientId)) {
      clients.get(clientId).status = "offline";
      logEvent("DISCONNECTION", { clientId });

      // Keep client in the list for some time before removing
      setTimeout(() => {
        // Only remove if still offline after timeout
        if (
          clients.has(clientId) &&
          clients.get(clientId).status === "offline"
        ) {
          clients.delete(clientId);
          logEvent("CLIENT_REMOVED", { clientId });
        }
      }, 3600000); // 1 hour
    }
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  logEvent("SERVER_START", { port: PORT });
});
