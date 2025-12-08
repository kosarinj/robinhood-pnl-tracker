# Use Node 20 (required by better-sqlite3)
FROM node:20-alpine

# Install Python and build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

# Set working directory
WORKDIR /app

# Copy package files from server directory
COPY server/package*.json ./

# Install dependencies
RUN npm install --production

# Copy application code from server directory
COPY server/ .

# Expose port (Railway will inject PORT env var)
EXPOSE 8080

# Start the server
CMD ["node", "--max-old-space-size=512", "index.js"]
