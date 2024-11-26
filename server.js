// server.js
const express = require('express');
const multer = require('multer');
const { createLogger, format, transports } = require('winston');
const path = require('path');
const vision = require('@google-cloud/vision');
require('dotenv').config();
const fs = require('fs').promises;
const stream = require('stream');
const poppler = require('pdf-poppler')

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
    constructor() {
        // Initialize Google Cloud Vision client
        this.visionClient = new vision.ImageAnnotatorClient({
            keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS
        });
    }

    async extractTextFromFile(filePath) {
        // Log full details about the file
        logger.info(`Full file path: ${filePath}`);
        
        // Use fs to verify file existence and get more details
        try {
            const fileStats = await fs.stat(filePath);
            logger.info(`File size: ${fileStats.size} bytes`);
        } catch (statError) {
            logger.error(`Error getting file stats: ${statError.message}`);
        }
    
        // Try to get extension from the original filename
        const originalFilename = path.basename(filePath);
        const originalExt = path.extname(originalFilename).toLowerCase();
        logger.info(`Original filename: ${originalFilename}`);
        logger.info(`Original file extension: "${originalExt}"`);
    
        try {
            if (originalExt === '.pdf') {
                return await this.processPDF(filePath);
            } else if (['.jpg', '.jpeg', '.png', '.bmp', '.pdf'].includes(originalExt)) {
                return await this.processImage(filePath);
            } else {
                // Try to detect file type using file magic numbers
                const fileBuffer = await fs.readFile(filePath, { length: 4 });
                const fileSignature = fileBuffer.toString('hex');
    
                // PDF file signature
                if (fileSignature.startsWith('25504446')) {
                    return await this.processPDF(filePath);
                }
    
                throw new Error(`Unsupported file type: "${originalExt}" for file: ${originalFilename}`);
            }
        } catch (error) {
            logger.error(`Detailed OCR Processing Error: ${error.message}`);
            logger.error(`Full error details: ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`);
            throw error;
        }
    }

    async processPDF(pdfPath) {
        logger.info(`Converting PDF: ${pdfPath}`);
        
        const tempDir = './temp_images';
        await fs.mkdir(tempDir, { recursive: true });
    
        let allText = '';
    
        try {
            // Get PDF page count
            const opts = {
                format: 'png',
                out_dir: tempDir,
                out_prefix: 'page_',
                page: null // convert all pages
            };
    
            // Convert PDF to images
            const convertedImages = await poppler.convert(pdfPath, opts);
            
            // Process each converted image
            const imageFiles = await fs.readdir(tempDir);
            const pdfImages = imageFiles.filter(file => 
                file.startsWith('page_') && path.extname(file) === '.png'
            ).sort();
    
            for (const [index, imageName] of pdfImages.entries()) {
                const imagePath = path.join(tempDir, imageName);
                logger.info(`Processing page ${index + 1}: ${imagePath}`);
    
                try {
                    const pageText = await this.processImage(imagePath, index + 1);
                    allText += pageText + '\n\n';
    
                    // Clean up individual page image
                    await fs.unlink(imagePath);
                } catch (pageError) {
                    logger.error(`Error processing page ${index + 1}: ${pageError.message}`);
                }
            }
    
            return allText.trim();
        } catch (error) {
            logger.error(`PDF Processing Error: ${error.message}`);
            logger.error(`Full error details: ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`);
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
            throw error;
        }
    }

    chunkText(text, options = {}) {
        const {
            chunkSize = 500,
            chunkOverlap = 100,
            separators = ['\n\n', '. ', '! ', '? ']
        } = options;

        const chunks = [];
        let start = 0;

        while (start < text.length) {
            let end = start + chunkSize;
            let bestCut = end;

            // Find best cut point
            for (const sep of separators) {
                const cutIndex = text.lastIndexOf(sep, end);
                if (cutIndex !== -1 && cutIndex > start) {
                    bestCut = cutIndex + sep.length;
                    break;
                }
            }

            // Extract chunk
            const chunk = text.slice(start, bestCut).trim();
            chunks.push(chunk);

            // Move start with overlap
            start = bestCut - chunkOverlap;
        }

        return chunks;
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
    if (!req.file) {
        logger.error('No file uploaded or file upload failed');
        return res.status(400).json({
            message: 'No file uploaded',
            details: 'File upload may have failed due to unsupported file type or upload error'
        });
    }

    try {
        const ocrProcessor = new OCRProcessor();
        const extractedText = await ocrProcessor.extractTextFromFile(req.file.path);
        
        res.type('text/plain');
        
        const textStream = new stream.Readable();
        textStream.push(extractedText);
        textStream.push(null);
        textStream.pipe(res);

        logger.info(`OCR completed for file: ${req.file.originalname}`);
    } catch (error) {
        logger.error(`OCR Processing Error for file ${req.file.originalname}:`, error);
        
        try {
            await fs.unlink(req.file.path);
        } catch (unlinkError) {
            logger.warn(`Could not delete file after error: ${unlinkError.message}`);
        }

        res.status(500).json({
            message: 'OCR Processing failed',
            error: error.message,
            details: JSON.stringify(error, Object.getOwnPropertyNames(error))
        });
    }
});

// Server Configuration
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
    logger.info(`Server running on http://${HOST}:${PORT}`);
});