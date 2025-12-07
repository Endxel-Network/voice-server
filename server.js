const dgram = require("dgram");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;

ffmpeg.setFfmpegPath(ffmpegPath);

// =============================
// CONFIGURATION
// =============================

// MP3 bitrate (choose any: 32k, 64k, 96k, 128k, 192k)
const MP3_BITRATE = "64k";

// audio format from clients
const SAMPLE_RATE = 8000;
const CHANNELS = 1;

// cleanup: delete files older than X days
const CLEANUP_DAYS = 30;

// server listen port
const PORT = 1098;

// =============================

const OUTPUT_DIR = "./recordings";
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

function todayTag() {
    return new Date().toLocaleDateString("en-GB").replace(/\//g, "-");
}

const dateTag = todayTag();
const server = dgram.createSocket("udp4");

const clients = new Map();  // "ip:port" -> username
const userProcesses = new Map(); // username -> ffmpeg process
const userInputs = new Map(); // username -> stream writable to ffmpeg

// ---------------------------------------------
// CREATE COMBINED RECORDING
// ---------------------------------------------
const combinedOutput = path.join(OUTPUT_DIR, `combined-${dateTag}.mp3`);
const combinedInput = fs.createWriteStream(null, { fd: fs.openSync("/dev/null", "w") });

const combinedProc = ffmpeg()
    .input("pipe:0")
    .inputOptions([
        `-f s16le`,
        `-ar ${SAMPLE_RATE}`,
        `-ac ${CHANNELS}`
    ])
    .audioBitrate(MP3_BITRATE)
    .save(combinedOutput);

combinedProc.on("start", () => console.log("Combined MP3 encoder started"));
combinedProc.on("error", err => console.error("Combined FFmpeg error:", err.message));

combinedInput.pipe(combinedProc.stdin);

// ---------------------------------------------
// UDP SERVER LOGIC
// ---------------------------------------------
server.on("listening", () => {
    console.log(`Voice server running on port ${PORT}`);
});

server.on("message", (msg, rinfo) => {
    if (msg.length < 2) return;

    const nameLen = msg[0];
    const username = msg.slice(1, 1 + nameLen).toString("utf8");
    const audio = msg.slice(1 + nameLen);

    const clientKey = `${rinfo.address}:${rinfo.port}`;

    if (!clients.has(clientKey)) {
        clients.set(clientKey, username);
        console.log(`Client connected: ${username} (${clientKey})`);

        // create per-user MP3 process
        const userFile = path.join(OUTPUT_DIR, `${username}-${dateTag}.mp3`);
        const input = fs.createWriteStream(null, { fd: fs.openSync("/dev/null", "w") });
        userInputs.set(username, input);

        const proc = ffmpeg()
            .input("pipe:0")
            .inputOptions([
                `-f s16le`,
                `-ar ${SAMPLE_RATE}`,
                `-ac ${CHANNELS}`
            ])
            .audioBitrate(MP3_BITRATE)
            .save(userFile);

        proc.on("start", () => console.log(`User encoder started: ${username}`));
        proc.on("error", err => console.error(`User ${username} FFmpeg error:`, err.message));

        input.pipe(proc.stdin);
        userProcesses.set(username, proc);
    }

    // write to combined recording
    combinedProc.stdin.write(audio);

    // write to user's individual recording
    const userStream = userInputs.get(username);
    if (userStream) userStream.write(audio);

    // broadcast to other clients
    for (const [key, user] of clients.entries()) {
        if (key !== clientKey) {
            const [ip, port] = key.split(":");
            server.send(msg, Number(port), ip);
        }
    }
});

// ---------------------------------------------
// FILE CLEANUP (30 days)
// ---------------------------------------------
function cleanupOldFiles() {
    const files = fs.readdirSync(OUTPUT_DIR);
    const cutoff = Date.now() - CLEANUP_DAYS * 24 * 60 * 60 * 1000;

    for (const file of files) {
        const fullPath = path.join(OUTPUT_DIR, file);
        const stat = fs.statSync(fullPath);

        if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(fullPath);
            console.log(`Deleted old file: ${file}`);
        }
    }
}

cleanupOldFiles();
setInterval(cleanupOldFiles, 24 * 60 * 60 * 1000); // once per day

// ---------------------------------------------
server.bind(PORT);
