
const express = require('express');
const multer = require('multer');
const { createLogger, format, transports } = require('winston');
const path = require('path');
const vision = require('@google-cloud/vision');
require('dotenv').config();
const fs = require('fs').promises;
const stream = require('stream');
const { exec } = require('child_process');
const util = require('util');

// Logging Setup
const logger = createLogger({
    level: 'info',
    format: format.combine(
        format.timestamp(),
        format.printf(({ timestamp, level, message }) => {
            return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
        })
    ),
    transports: [
        new transports.Console(),
        new transports.File({ filename: 'app.log' })
    ]
});

class OCRProcessor {
    constructor(responseStream) {
        this.visionClient = new vision.ImageAnnotatorClient({
            keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS
        });
        this.execPromise = util.promisify(exec);
        this.responseStream = responseStream;
        this.totalPagesProcessed = 0;
    }

    // Send incremental update to the client
    sendUpdate(message, isComplete = false, text = null, totalPages = null) {
        const updatePacket = {
            message,
            pageNumber: this.totalPagesProcessed,
            totalPages: totalPages,
            isComplete
        };
    
        // If text is large, encode it in base64
        if (text !== null) {
            if (text.length > 10000) { // Adjust threshold as needed
                updatePacket.text = Buffer.from(text).toString('base64');
                updatePacket.isBase64 = true;
            } else {
                updatePacket.text = text;
            }
        }
    
        // Use a try-catch to handle any potential JSON stringification errors
        try {
            const jsonString = JSON.stringify(updatePacket);
            this.responseStream.write(`data: ${jsonString}\n\n`);
        } catch (error) {
            logger.error(`Error stringifying update: ${error.message}`);
            this.responseStream.write(`data: ${JSON.stringify({
                message: 'Error processing text',
                error: error.message,
                isComplete: true
            })}\n\n`);
        }
    }

    async extractTextFromFile(filePath) {
        logger.info(`Full file path: ${filePath}`);
        this.sendUpdate(`Starting OCR processing for file: ${path.basename(filePath)}`);

        const originalExt = path.extname(path.basename(filePath)).toLowerCase();

        try {
            if (originalExt === '.pdf') {
                return await this.processPDF(filePath);
            } else if (['.jpg', '.jpeg', '.png', '.bmp'].includes(originalExt)) {
                return await this.processImage(filePath);
            } else {
                throw new Error(`Unsupported file type: "${originalExt}"`);
            }
        } catch (error) {
            this.sendUpdate(`OCR Processing Error: ${error.message}`, true);
            logger.error(`Detailed OCR Processing Error: ${error.message}`);
            throw error;
        }
    }

    async processPDF(pdfPath) {
        logger.info(`Converting PDF: ${pdfPath}`);
        this.sendUpdate('Converting PDF to images...');
    
        const tempDir = './temp_images';
        await fs.mkdir(tempDir, { recursive: true });
        
        // Clear previous temporary images
        await fs.readdir(tempDir)
            .then(files => Promise.all(files.map(file => fs.unlink(path.join(tempDir, file)))))
            .catch(err => logger.warn(`Error clearing temp directory: ${err.message}`));
    
        let allText = '';
        const PAGES_PER_UPDATE = 5;
    
        try {
            // Convert PDF to images using pdftoppm
            await this.execPromise(`pdftoppm -png ${pdfPath} ${path.join(tempDir, 'page')}`);
    
            const imageFiles = await fs.readdir(tempDir);
            const pdfImages = imageFiles.filter(file =>
                file.startsWith('page-') && path.extname(file) === '.png'
            ).sort();
    
            const totalPages = pdfImages.length;
            this.totalPagesProcessed = 0;
    
            for (const [index, imageName] of pdfImages.entries()) {
                const imagePath = path.join(tempDir, imageName);
                logger.info(`Processing page ${index + 1}: ${imagePath}`);
    
                try {
                    const pageText = await this.processImage(imagePath, index + 1);
                    allText += pageText + '\n\n';
                    this.totalPagesProcessed++;
    
                    // Send incremental text update every 5 pages
                    if ((index + 1) % PAGES_PER_UPDATE === 0 || index === pdfImages.length - 1) {
                        this.sendUpdate(`Processed pages up to ${index + 1}`, false, allText, totalPages);
                    }
    
                    // Clean up individual page image
                    await fs.unlink(imagePath);
                } catch (pageError) {
                    logger.error(`Error processing page ${index + 1}: ${pageError.message}`);
                    this.sendUpdate(`Error processing page ${index + 1}: ${pageError.message}`, false, null, totalPages);
                }
            }
    
            // Final complete message
            this.sendUpdate('OCR processing complete', true, allText, totalPages);
            return allText.trim();
        } catch (error) {
            logger.error(`PDF Processing Error: ${error.message}`);
            this.sendUpdate(`PDF Processing Error: ${error.message}`, true);
            throw error;
        }
    }

    async processImage(imagePath, pageNumber = null) {
        logger.info(`Processing image: ${imagePath}`);

        try {
            const [result] = await this.visionClient.textDetection(imagePath);
            const detectedText = result.textAnnotations[0]?.description || '';

            const pagePrefix = pageNumber ? `\n\n----- Page ${pageNumber} -----\n\n` : '';
            return pagePrefix + detectedText;
        } catch (error) {
            logger.error(`Image Processing Error: ${error.message}`);
            this.sendUpdate(`Image Processing Error: ${error.message}`, true);
            throw error;
        }
    }
}

// Express App Setup
const app = express();
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const originalExt = path.extname(file.originalname);
        cb(null, file.fieldname + '-' + uniqueSuffix + originalExt);
    }
});

const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['.pdf', '.jpg', '.jpeg', '.png', '.bmp'];
        const ext = path.extname(file.originalname).toLowerCase();

        logger.info(`Uploaded file: ${file.originalname}, Original Extension: ${ext}`);

        if (allowedTypes.includes(ext)) {
            cb(null, true);
        } else {
            logger.error(`Rejected file type: ${ext}`);
            cb(new Error(`Unsupported file type: ${ext}`), false);
        }
    }
});

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

//Routes
app.post('/ocr', upload.single('file'), async (req, res) => {
    req.setTimeout(10 * 60 * 1000); // 10 minute timeout
    res.setTimeout(10 * 60 * 1000);

    // Set up Server-Sent Events headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-open'
    });

    if (!req.file) {
        logger.error('No file uploaded or file upload failed');
        res.write(`data: ${JSON.stringify({
            message: 'No file uploaded',
            isComplete: true
        })}\n\n`);
        res.end();
        return;
    }

    try {
        const ocrProcessor = new OCRProcessor(res);
        const extractedText = await ocrProcessor.extractTextFromFile(req.file.path);

        // Send final text as a separate event
        res.write(`data: ${JSON.stringify({
            message: 'Final Text',
            text: extractedText,
            isComplete: true
        })}\n\n`);

        res.end();

        logger.info(`OCR completed for file: ${req.file.originalname}`);
    } catch (error) {
        logger.error(`OCR Processing Error for file ${req.file.originalname}:`, error);

        try {
            await fs.unlink(req.file.path);
        } catch (unlinkError) {
            logger.warn(`Could not delete file after error: ${unlinkError.message}`);
        }

        res.write(`data: ${JSON.stringify({
            message: 'OCR Processing failed',
            error: error.message,
            isComplete: true
        })}\n\n`);
        res.end();
    }
});

// Server Configuration
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    logger.info(`Server running on http://${PORT}`);
});