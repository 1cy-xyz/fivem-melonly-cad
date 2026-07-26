# FiveM / Melonly Hybrid CAD System

Customizable CAD/MDT system with real-time Socket.io updates, multi-tenancy, custom join codes, and owner customization.

## Deploying to Render
1. Push this repository to GitHub.
2. Create a **New Web Service** on Render.
3. Link your GitHub repository.
4. Set Build Command: `npm install && npx prisma generate && npx prisma db push`
5. Set Start Command: `npm start`
6. Add Environment Variable: `JWT_SECRET` = `your_secret_key`
