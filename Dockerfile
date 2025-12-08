# Use Node 20 for consistency
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application code
COPY . .

# Build the Vite app
RUN npm run build

# Expose port (Railway will inject PORT env var)
EXPOSE 8080

# Start the preview server
CMD npx vite preview --port ${PORT:-8080} --host 0.0.0.0
