#!/usr/bin/env python3
"""
Re-authorize Google OAuth2 token.
Run this when the refresh token is expired/revoked.

Usage: python3 scripts/google-reauth.py
"""

import json
import os
from pathlib import Path

try:
    from google_auth_oauthlib.flow import InstalledAppFlow
except ImportError:
    print("Installing google-auth-oauthlib...")
    os.system("pip3 install google-auth-oauthlib")
    from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/spreadsheets",
]

CLIENT_SECRET = Path.home() / ".lobs/credentials/client_secret.json"
TOKEN_PATH = Path.home() / ".lobs/credentials/google_token.json"

if not CLIENT_SECRET.exists():
    print(f"ERROR: {CLIENT_SECRET} not found")
    exit(1)

print(f"Starting OAuth flow with client secret: {CLIENT_SECRET}")
print("A browser window will open. Sign in with thelobsbot@gmail.com\n")

flow = InstalledAppFlow.from_client_secrets_file(str(CLIENT_SECRET), SCOPES)
creds = flow.run_local_server(port=8089)

# Save the token in the format our google-calendar.ts expects
token_data = {
    "token": creds.token,
    "refresh_token": creds.refresh_token,
    "token_uri": creds.token_uri,
    "client_id": creds.client_id,
    "client_secret": creds.client_secret,
    "scopes": creds.scopes,
}

with open(TOKEN_PATH, "w") as f:
    json.dump(token_data, f, indent=2)

print(f"\n✅ Token saved to {TOKEN_PATH}")
print("Google Calendar and other APIs should now work.")
