#!/bin/bash

# QAtalyst Chrome Extension Build Script
# Packages the extension for Chrome Web Store submission

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  QAtalyst Extension Builder v1.0      ║${NC}"
echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo ""

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
EXTENSION_DIR="$SCRIPT_DIR/chrome-extension"
OUTPUT_DIR="$SCRIPT_DIR"

# Check if chrome-extension directory exists
if [ ! -d "$EXTENSION_DIR" ]; then
    echo -e "${RED}✗ Error: chrome-extension directory not found!${NC}"
    exit 1
fi

# Read version from manifest.json
MANIFEST_FILE="$EXTENSION_DIR/manifest.json"
if [ ! -f "$MANIFEST_FILE" ]; then
    echo -e "${RED}✗ Error: manifest.json not found!${NC}"
    exit 1
fi

# Extract version using grep and sed (works on macOS and Linux)
VERSION=$(grep '"version"' "$MANIFEST_FILE" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')

if [ -z "$VERSION" ]; then
    echo -e "${RED}✗ Error: Could not extract version from manifest.json${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Found extension version: ${YELLOW}$VERSION${NC}"

# Create output filename
OUTPUT_FILE="$OUTPUT_DIR/qatalyst-v${VERSION}-webstore.zip"

# Remove old zip if exists
if [ -f "$OUTPUT_FILE" ]; then
    echo -e "${YELLOW}⚠ Removing old package: qatalyst-v${VERSION}-webstore.zip${NC}"
    rm "$OUTPUT_FILE"
fi

echo -e "${BLUE}► Packaging extension...${NC}"

# Change to extension directory
cd "$EXTENSION_DIR"

# Create zip file excluding:
# - .DS_Store (macOS)
# - .git* (git files)
# - node_modules (dependencies)
# - README.md (docs)
# - *.log (log files)
# - .env* (environment files)
zip -r "$OUTPUT_FILE" . \
    -x "*.DS_Store" \
    -x "*.git*" \
    -x "node_modules/*" \
    -x "README.md" \
    -x "*.log" \
    -x ".env*" \
    -x "*.md" \
    > /dev/null 2>&1

# Check if zip was created successfully
if [ ! -f "$OUTPUT_FILE" ]; then
    echo -e "${RED}✗ Error: Failed to create zip file!${NC}"
    exit 1
fi

# Get file size
FILE_SIZE=$(du -h "$OUTPUT_FILE" | cut -f1)

echo ""
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║        BUILD SUCCESSFUL! ✓             ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}📦 Package Details:${NC}"
echo -e "   Version:  ${YELLOW}$VERSION${NC}"
echo -e "   File:     ${YELLOW}qatalyst-v${VERSION}-webstore.zip${NC}"
echo -e "   Size:     ${YELLOW}$FILE_SIZE${NC}"
echo -e "   Location: ${YELLOW}$OUTPUT_DIR${NC}"
echo ""
echo -e "${BLUE}📋 Next Steps:${NC}"
echo -e "   1. Go to: ${YELLOW}https://chrome.google.com/webstore/devconsole${NC}"
echo -e "   2. Click: ${YELLOW}Upload New Item${NC} or ${YELLOW}Update Existing${NC}"
echo -e "   3. Upload: ${YELLOW}qatalyst-v${VERSION}-webstore.zip${NC}"
echo -e "   4. Review and publish"
echo ""
echo -e "${GREEN}✓ Ready for Chrome Web Store submission!${NC}"
echo ""
