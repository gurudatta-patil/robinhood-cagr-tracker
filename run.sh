#!/bin/bash

# Stock Portfolio Tracker Startup Script

echo "🚀 Starting Stock Portfolio Tracker..."

# Navigate to the project directory
cd "$(dirname "$0")"

# Check if virtual environment exists
if [ ! -d "venv" ]; then
    echo "📦 Creating virtual environment..."
    python3 -m venv venv
fi

# Activate virtual environment
echo "🔧 Activating virtual environment..."
source venv/bin/activate

# Install dependencies if needed
echo "📋 Installing dependencies..."
pip install -q flask pandas requests

# Start the Flask application
echo "🌐 Starting web server..."
echo "📱 Open your browser and go to: http://localhost:5001"
echo "⚡ Press Ctrl+C to stop the server"
echo ""

python app.py
