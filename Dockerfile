# Use Node 20 for consistency
FROM node:20-slim

# Install build tools needed for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies. The flag matches railway.toml's buildCommand: without
# it the real build fails on peer-dependency conflicts, so a plain install here
# would have been a Dockerfile that could not even finish building.
RUN npm install --legacy-peer-deps

# Copy application code
COPY . .

# Build the Vite app
RUN npm run build

# Expose port (Railway will inject PORT env var)
EXPOSE 8080

# Start the same thing Railway starts: the Express app in server/, which serves
# the built frontend AND the /api routes, the database and auth.
#
# This used to run `npx vite preview`, which serves only the static build. An
# app started that way looks perfectly normal and then fails every API call,
# because nothing is listening on /api at all. It never bit because
# railway.toml pins the build to nixpacks with `npm start` -- but Railway
# prefers a Dockerfile when it finds one, so any new service or environment
# created from this repo would have picked this up and quietly broken.
CMD ["npm", "start"]
