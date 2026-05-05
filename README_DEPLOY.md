# Couple Chat Deployment

This app is ready for a public Python web host such as Render or Railway.

## Run locally

```powershell
C:\Users\maury\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe chat_server.py
```

Open:

```text
http://127.0.0.1:3000
```

## Deploy on Render

1. Create a new Web Service.
2. Upload/connect this project folder.
3. Use:
   - Build command: `pip install -r requirements.txt`
   - Start command: `python chat_server.py`
4. Keep environment variable `HOST=0.0.0.0`.

After deployment, Render gives a URL like:

```text
https://your-app-name.onrender.com
```

Anyone can open that URL on any phone, enter their name and the secure room code, and chat.

## Security note

Message text is encrypted in the browser with AES-GCM. The server stores/transmits encrypted text only. The secure room code is also the secret used to derive the encryption key, so do not share it publicly. Room metadata, sender names, delivery status, and seen status are visible to the server.
