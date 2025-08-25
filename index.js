const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();
const path = require('path');
const fetch = require('node-fetch');
const cookieParser = require('cookie-parser');
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const RestrictionsConfig = require('./Schemas/erlcRestrictions');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const SkyUtilitiesERLCConfig = require('./Schemas/erlcConfig');
const RemindersConfig = require('./Schemas/reminderConfig');

const app = express();

app.use(cookieParser());
app.use(cors());
app.use(express.json());

const noCache = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
};

app.use('/api', noCache);

app.use(express.static(path.join(__dirname)));

app.get('/server/:guildId', (req, res) => {
    const guildId = req.params.guildId;
    if (!guildId || guildId.includes('.')) {
        console.log(`Invalid server ID format: ${guildId}. Redirecting to not_found.html.`);
        return res.status(404).sendFile(path.join(__dirname, 'not_found.html'));
    }
    res.sendFile(path.join(__dirname, 'erlc_info.html'));
});

app.get('/panel/:guildId', (req, res) => {
    const guildId = req.params.guildId;
    if (!guildId || guildId.includes('.')) {
        console.log(`Invalid server ID format: ${guildId}. Redirecting to not_found.html.`);
        return res.status(404).sendFile(path.join(__dirname, 'not_found.html'));
    }
    res.sendFile(path.join(__dirname, 'dev.html'));
});
mongoose.connect(process.env.mongoURL, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => console.log('MongoDB connected'))
.catch(console.error);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.User],
});

if (process.env.TOKEN) {
    client.login(process.env.TOKEN)
        .then(() => console.log(`Discord client logged in as ${client.user.tag}`))
        .catch(err => console.error('Failed to log in Discord client:', err));
} else {
    console.warn('DISCORD_BOT_TOKEN not found in .env. Discord bot features will be limited.');
}

app.use((req, res, next) => {
    if (req.path.startsWith('/api/guilds/') && !client.isReady()) {
        return res.status(503).json({ message: 'Discord bot is not ready yet. Please try again in a moment.' });
    }
    next();
});

let genAI;
let aiModel;
if (process.env.GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    aiModel = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
    console.log("Google Generative AI initialized.");
} else {
    console.warn("GEMINI_API_KEY not found in .env. AI assistant features will be disabled.");
}

app.post('/api/ai-chat', async (req, res) => {
    if (!aiModel) {
        return res.status(503).json({ error: 'AI assistant is not configured (missing API key).' });
    }

    const userQuestion = req.body.question;
    if (!userQuestion) {
        return res.status(400).json({ error: 'Question is required.' });
    }

    try {
        const prompt = `You are an AI assistant for SkyUtilities, a bot for ERLC. Answer questions specifically about ERLC (Emergency Response: Liberty County) on Roblox, the SkyUtilities Discord bot's features, and the SkyUtilities website (its pages, functionalities).
If a question is outside these topics or you don't have enough information, politely state that you cannot assist with that specific query.
Ensure your answers are concise, helpful, and directly address the user's query based on the specified context.

User question: ${userQuestion}`;

        const result = await aiModel.generateContent(prompt);
        const response = await result.response;
        const aiAnswer = response.text();

        res.json({ answer: aiAnswer });

    } catch (error) {
        console.error('Error processing AI request:', error);
        let errorMessage = 'Failed to get a response from the AI assistant. Please try again later.';
        if (error.response && error.response.status === 429) {
            errorMessage = 'Too many requests to the AI model. Please wait a moment and try again.';
        } else if (error.message.includes('API key')) {
             errorMessage = 'AI service not accessible. Ensure your API key is valid and configured correctly.';
        }
        res.status(500).json({ error: errorMessage, details: error.message });
    }
});

app.get('/api/guilds/:guildId/members', async (req, res) => {
    const { guildId } = req.params;

    try {
        const guild = await client.guilds.fetch(guildId);
        if (!guild) {
            console.warn(`Guild with ID ${guildId} not found or bot is not in it.`);
            return res.status(404).json({ message: 'Discord guild not found or bot is not in this guild.' });
        }

        const members = await guild.members.fetch();

        const simplifiedMembers = members.map(member => ({
            id: member.user.id,
            username: member.user.username,
            displayName: member.nickname || member.user.globalName || member.user.username,
        }));

        res.json(simplifiedMembers);

    } catch (error) {
        console.error(`Error fetching Discord guild members for ${guildId}:`, error);
        if (error.code === 10003) {
             return res.status(404).json({ message: 'Discord guild not found.' });
        } else if (error.code === 50001) {
             return res.status(403).json({ message: 'Bot does not have access to this guild or missing permissions.' });
        }
        res.status(500).json({ message: 'Failed to fetch Discord guild members.' });
    }
});


app.get('/login', (req, res) => {
    if (req.cookies && req.cookies.discord_token) {
        return res.redirect('/dashboard.html');
    }
    res.redirect('/login/discord');
});

app.get('/login/discord', (req, res) => {
    const redirectUri = encodeURIComponent(`${process.env.BASE_URL || 'http://localhost:8080'}/api/callback`);
    const scope = ['identify', 'guilds'].join('%20');
    const discordAuthUrl = `https://discord.com/oauth2/authorize?client_id=1377632934965674055&permissions=8&response_type=code&redirect_uri=${redirectUri}&integration_type=0&scope=${scope}`;
    res.redirect(discordAuthUrl);
});

app.get('/api/callback', async (req, res) => {
    console.log('HIT /api/callback');
    const code = req.query.code;
    if (!code) return res.status(400).send('No code provided');

    const params = new URLSearchParams();
    params.append('client_id', process.env.DISCORD_CLIENT_ID);
    params.append('client_secret', process.env.DISCORD_CLIENT_SECRET);
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    params.append('redirect_uri', `${process.env.BASE_URL || 'http://localhost:8080'}/api/callback`);
    params.append('scope', 'identify guilds');

    try {
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            body: params,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });

        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) {
            console.error('Failed to obtain access token:', tokenData);
            return res.status(400).json({ error: 'Failed to obtain access token', details: tokenData });
        }

        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        const userData = await userRes.json();

        res.cookie('discord_token', tokenData.access_token, { httpOnly: false, maxAge: 7 * 24 * 60 * 60 * 1000 });
        res.cookie('user_id', userData.id, { httpOnly: false, maxAge: 7 * 24 * 60 * 60 * 1000 });

        res.redirect('/dashboard.html');
    } catch (error) {
        console.error('OAuth callback error:', error);
        res.status(500).send('OAuth callback error');
    }
});

app.get('/logout', (req, res) => {
    res.clearCookie('discord_token');
    res.clearCookie('user_id');
    res.redirect('index.html');
});

app.get('/api/stats', (req, res) => {
    if (!client || !client.isReady()) { 
        return res.status(503).json({ error: 'Bot client is not ready' });
    }

    try {
        const totalServers = client.guilds.cache.size;
        const totalMembers = client.guilds.cache.reduce((acc, guild) => acc + (guild.memberCount || 0), 0);

        const discordChecks = 15000;

        res.status(200).json({
            servers: totalServers,
            members: totalMembers,
            discordChecks: discordChecks
        });
    } catch (e) {
        console.error('Error fetching bot stats:', e);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/me', async (req, res) => {
    const token = req.cookies.discord_token;
    if (!token) return res.status(401).json({ message: 'Not logged in' });

    try {
        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!userRes.ok) {
            res.clearCookie('discord_token');
            res.clearCookie('user_id');
            return res.status(401).json({ message: 'Invalid or expired token, please log in again.' });
        }

        const userData = await userRes.json();
        res.json(userData);
    } catch (err) {
        console.error('Error fetching user data:', err);
        res.status(500).json({ message: 'Server error fetching user data' });
    }
});

app.get('/api/servers/me', async (req, res) => {
    const token = req.cookies.discord_token;
    if (!token) return res.status(401).json({ message: 'Not logged in' });

    try {
        const guildsRes = await fetch('https://discord.com/api/users/@me/guilds', {
            headers: { Authorization: `Bearer ${token}` }
        });

        if (!guildsRes.ok) {
            res.clearCookie('discord_token');
            res.clearCookie('user_id');
            return res.status(401).json({ message: 'Cannot fetch guilds, please log in again.' });
        }

        const userGuilds = await guildsRes.json();
        const result = userGuilds
            .filter(guild => {
                const permissions = BigInt(guild.permissions);
                return (permissions & BigInt(0x00000008)) === BigInt(0x00000008);
            })
            .map(guild => ({
                id: guild.id,
                name: guild.name,
                iconUrl: guild.icon
                    ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png`
                    : 'https://cdn.discordapp.com/embed/avatars/0.png',
                hasBot: client.guilds.cache.has(guild.id)
            }));

        res.json(result);
    } catch (err) {
        console.error('Error fetching servers:', err);
        res.status(500).json({ message: 'Internal server error fetching servers' });
    }
});

app.get('/dashboard.html', (req, res) => {
    if (!req.cookies.discord_token) {
        return res.redirect('https://discord.com/oauth2/authorize?client_id=1377632934965674055&permissions=8&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fapi%2Fcallback&integration_type=0&scope=applications.commands+bot+identify+guilds');
    }
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/dashboard/server/:guildId', (req, res) => {
    if (!req.cookies.discord_token) {
        return res.redirect('https://discord.com/oauth2/authorize?client_id=1377632934965674055&permissions=8&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fapi%2Fcallback&integration_type=0&scope=applications.commands+bot+identify+guilds');
    }
    res.sendFile(path.join(__dirname, 'server.html'));
});

app.get('/api/erlc/:guildId', async (req, res) => {
    try {
        const config = await SkyUtilitiesERLCConfig.findOne({ guildId: req.params.guildId });
        if (!config) {
            return res.status(404).json({ message: 'ERLC config not found', disabled: true });
        }
        res.json(config);
    } catch (error) {
        console.error('Error fetching ERLC config:', error);
        res.status(500).json({ message: 'Server error fetching ERLC config', error: error.message });
    }
});

app.post('/api/erlc', async (req, res) => {
    try {
        const { guildId, apiKey, staffRoleId, hrRoleId, commandLogsChannelId, disabled } = req.body;

        if (!guildId) {
            return res.status(400).json({ message: 'Missing guildId.' });
        }

        const update = {
            apiKey: apiKey,
            staffRoleId: staffRoleId,
            hrRoleId: hrRoleId,
            commandLogsChannelId: commandLogsChannelId,
            disabled: disabled
        };

        const options = { upsert: true, new: true, setDefaultsOnInsert: true };

        const config = await SkyUtilitiesERLCConfig.findOneAndUpdate({ guildId: guildId }, update, options);
        res.json(config);
    } catch (error) {
        console.error('Error saving ERLC config:', error);
        res.status(500).json({ message: 'Server error saving ERLC config', error: error.message });
    }
});

app.delete('/api/server-config/clear-erlc/:guildId', async (req, res) => {
    try {
        const { guildId } = req.params;
        const result = await SkyUtilitiesERLCConfig.deleteOne({ guildId: guildId });

        if (result.deletedCount === 0) {
            return res.status(404).json({ message: 'No ERLC configuration found to clear.' });
        }
        res.status(200).json({ message: 'ERLC configuration cleared successfully!' });
    } catch (error) {
        console.error('Error clearing ERLC config:', error);
        res.status(500).json({ message: 'Server error clearing ERLC config', error: error.message });
    }
});

app.get('/api/reminders/:guildId', async (req, res) => {
    try {
        const config = await RemindersConfig.findOne({ guildId: req.params.guildId });
        if (!config) {
            return res.status(404).json({ message: 'Reminders config not found', disabled: true });
        }
        res.json(config);
    } catch (error) {
        console.error('Error fetching Reminders config:', error);
        res.status(500).json({ message: 'Server error fetching Reminders config', error: error.message });
    }
});

app.post('/api/reminders', async (req, res) => {
    try {
        const { guildId, reminderText, reminderInterval, disabled } = req.body;
        if (!guildId || !reminderText || reminderInterval === undefined || reminderInterval === null || disabled === undefined || disabled === null) {
            return res.status(400).json({ message: 'Missing required Reminder configuration fields.' });
        }

        const update = { reminderText, reminderInterval, disabled };
        const options = { upsert: true, new: true, setDefaultsOnInsert: true };

        const config = await RemindersConfig.findOneAndUpdate({ guildId: guildId }, update, options);
        res.json(config);
    } catch (error) {
        console.error('Error saving Reminders config:', error);
        res.status(500).json({ message: 'Server error saving Reminders config', error: error.message });
    }
});

app.delete('/api/server-config/clear-reminders/:guildId', async (req, res) => {
    try {
        const { guildId } = req.params;
        const result = await RemindersConfig.deleteOne({ guildId: guildId });

        if (result.deletedCount === 0) {
            return res.status(404).json({ message: 'No Reminders configuration found to clear.' });
        }
        res.status(200).json({ message: 'Reminders configuration cleared successfully!' });
    } catch (error) {
        console.error('Error clearing Reminders config:', error);
        res.status(500).json({ message: 'Server error clearing Reminders config', error: error.message });
    }
});

app.use((req, res) => {
    console.log(`404: ${req.method} ${req.originalUrl}`);
    res.status(404).sendFile(path.join(__dirname, '/not_found.html'));
});
app.get('/api/restrictions/:guildId', async (req, res) => {
    const { guildId } = req.params;

    try {

        const restrictionsConfig = await getRestrictionsConfig(guildId); 

        if (restrictionsConfig) {
            res.json(restrictionsConfig);
        } else {
            res.status(404).send('No restrictions configuration found for this guild.');
        }
    } catch (error) {
        console.error('Error fetching restrictions config:', error);
        res.status(500).send('An error occurred while fetching restrictions.');
    }
});
app.post('/api/restrictions/:guildId', async (req, res) => {
    const { guildId } = req.params;
    const { liveryRestrictions, teamRestrictions, disabled } = req.body;

    if (!req.body || !guildId) {
        return res.status(400).send('Invalid request data.');
    }

    try {
        await saveRestrictionsConfig(guildId, {
            liveryRestrictions,
            teamRestrictions,
            disabled,
            guildId
        });

        res.status(200).send('Restrictions saved successfully.');
    } catch (error) {
        console.error('Error saving restrictions config:', error);
        res.status(500).send('An error occurred while saving restrictions.');
    }
});

console.log("REDIRECT_URI =", `${process.env.BASE_URL || 'http://localhost:8080'}/api/callback`);
console.log("CLIENT_ID =", process.env.DISCORD_CLIENT_ID);
console.log("CLIENT_SECRET =", process.env.DISCORD_CLIENT_SECRET);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
