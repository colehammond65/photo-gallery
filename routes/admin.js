// routes/admin.js
// Admin routes for managing images, categories, clients, and site settings.
// Includes middleware for authentication, rate limiting, and helpers for admin operations.

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const unzipper = require('unzipper');
const sharp = require('sharp');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const backupUtils = require('../utils/backup');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const validator = require('validator');
const _ = require('lodash');
const { fileTypeFromFile } = require('file-type');
const {
    getCategoriesWithImages,
    adminExists,
    createAdmin,
    getAdmin,
    verifyAdmin,
    getAllSettings,
    setSetting,
    getSetting,
    getSettingsWithDefaults,
    updateAltText,
    setCategoryThumbnail,
    saveImageOrder,
    getCategoryIdAndMaxPosition,
    isSafeCategory,
    categoryExists,
    createCategory,
    deleteCategory,
    deleteImage,
    addImage,
    getMaxImagePosition
} = require('../utils');
const {
    getAllClients,
    getClientById,
    getClientImages,
    addClientImage,
    deleteClientImage,
    deleteClient,
    toggleClientStatus,
    incrementDownloadCount,
    createZipArchive,
    CLIENT_UPLOADS_DIR,
    createClient
} = require('../utils/clients');
const { getAbout, updateAbout, updateAboutImage, deleteAboutImage } = require('../utils/about');

// Middleware to protect admin routes (moved from server.js)
// Ensures the user is logged in as admin
function requireLogin(req, res, next) {
    if (req.session && req.session.loggedIn) {
        next();
    } else {
        res.redirect('/login');
    }
}

// Redirect to /setup if admin account doesn't exist and not already on /setup (moved from server.js)
async function adminSetupRedirect(req, res, next) {
    try {
        const adminExistsResult = await adminExists();
        if (
            !adminExistsResult &&
            req.path !== '/setup' &&
            req.path !== '/setup/' &&
            !req.path.startsWith('/public') &&
            !req.path.startsWith('/styles') &&
            !req.path.startsWith('/images')
        ) {
            return res.redirect('/setup');
        }
        next();
    } catch (error) {
        console.error('Error in adminSetupRedirect middleware:', error);
        res.status(500).send('Internal Server Error');
    }
}

// Apply adminSetupRedirect to all admin routes
router.use(adminSetupRedirect);

const rateLimit = require('express-rate-limit');
const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests from this IP, please try again after 15 minutes.',
    standardHeaders: true,
    legacyHeaders: false,
});
const uploadsDir = path.join(__dirname, '../public/uploads');
const brandingDir = path.join(__dirname, '../data');
fs.mkdirSync(brandingDir, { recursive: true });

// Helper to validate uploaded file is a real image
async function isRealImage(filePath) {
    const type = await fileTypeFromFile(filePath);
    if (!type) return false;
    return ['image/png', 'image/jpeg', 'image/gif'].includes(type.mime);
}

router.get('/login', async (req, res) => {
    const settings = await getSettingsWithDefaults();
    res.render('login', { error: null, settings, showAdminNav: req.session && req.session.loggedIn });
});

// Login page (GET)
// Removed duplicate definition to avoid conflicts

// Handle login form (POST) -- RATE LIMITED
router.post('/login', adminLimiter, async (req, res) => {
    const { username, password } = req.body;
    const admin = await verifyAdmin(username, password);
    if (admin) {
        req.session.loggedIn = true;
        req.session.adminId = admin.id;
        return res.redirect('/admin/manage');
    } else {
        const settings = getSettingsWithDefaults();
        return res.render('login', { error: 'Invalid credentials', settings, showAdminNav: false, loggedIn: false });
    }
});

// Logout: destroy session and redirect to login
router.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

// Setup routes
router.get('/setup', async (req, res) => {
    if (adminExists()) {
        return res.redirect('/admin/login');
    }
    const settings = await getSettingsWithDefaults();
    res.render('setup', { error: null, settings, showAdminNav: req.session && req.session.loggedIn, req });
});

router.post('/setup', async (req, res) => {
    if (adminExists()) {
        return res.redirect('/admin/login');
    }
    const { username, password } = req.body;
    if (!username || !password || username.length < 3 || password.length < 8) {
        return res.render('setup', { error: 'Username and password are required. Username must be at least 3 characters and password at least 8 characters.', req });
    }
    await createAdmin(username, password);
    res.redirect('/admin/login');
});

// Settings update (protected) with file upload support
const settingsStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, brandingDir);
    },
    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname);
        cb(null, uuidv4() + ext);
    }
});
const settingsUpload = multer({
    storage: settingsStorage,
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
            return cb(new Error('Only image files are allowed!'), false);
        }
        cb(null, true);
    },
    limits: { fileSize: 5 * 1024 * 1024 }
});

router.post('/settings', requireLogin, settingsUpload.fields([
    { name: 'favicon', maxCount: 1 },
    { name: 'headerImage', maxCount: 1 }
]), async (req, res) => {
    // Sanitize and validate input
    let siteTitle = typeof req.body.siteTitle === 'string' ? validator.trim(req.body.siteTitle) : '';
    siteTitle = validator.escape(siteTitle).slice(0, 60);
    if (!siteTitle) siteTitle = 'Focal Point';

    let headerTitle = typeof req.body.headerTitle === 'string' ? validator.trim(req.body.headerTitle) : '';
    headerTitle = validator.escape(headerTitle).slice(0, 60);
    if (!headerTitle) headerTitle = 'Focal Point';

    let accentColor = typeof req.body.accentColor === 'string' ? validator.trim(req.body.accentColor) : '#2ecc71';
    accentColor = accentColor.replace(/[^#A-Fa-f0-9]/g, '');
    if (!/^#?[A-Fa-f0-9]{6,7}$/.test(accentColor)) accentColor = '#2ecc71';
    if (!accentColor.startsWith('#')) accentColor = '#' + accentColor;

    let headerType = 'text';
    if (typeof req.body.headerType === 'string') {
        headerType = req.body.headerType === 'image' ? 'image' : 'text';
    } else if (typeof req.body.headerTypeHidden === 'string') {
        headerType = req.body.headerTypeHidden === 'image' ? 'image' : 'text';
    }

    // Handle file uploads
    let favicon = '';
    if (req.files && req.files.favicon && req.files.favicon[0]) {
        favicon = req.files.favicon[0].filename;
    } else if (typeof req.body.favicon === 'string') {
        favicon = validator.escape(req.body.favicon);
    }

    let headerImage = '';
    if (req.files && req.files.headerImage && req.files.headerImage[0]) {
        headerImage = req.files.headerImage[0].filename;
    } else if (typeof req.body.headerImage === 'string') {
        headerImage = validator.escape(req.body.headerImage);
    }

    await setSetting('siteTitle', siteTitle);
    await setSetting('headerType', headerType);
    await setSetting('headerTitle', headerTitle);
    await setSetting('accentColor', accentColor);
    await setSetting('favicon', favicon);
    await setSetting('headerImage', headerImage);
    console.log('[admin/settings] Settings updated:', { siteTitle, headerType, headerTitle, accentColor, favicon, headerImage });

    // Ensure all settings keys are present after update
    const settings = await getAllSettings() || {};
    if (!('siteTitle' in settings)) await setSetting('siteTitle', 'Focal Point');
    if (!('headerTitle' in settings)) await setSetting('headerTitle', 'Focal Point');
    if (!('favicon' in settings)) await setSetting('favicon', '');
    if (!('accentColor' in settings)) await setSetting('accentColor', '#2ecc71');
    if (!('headerType' in settings)) await setSetting('headerType', 'text');
    if (!('headerImage' in settings)) await setSetting('headerImage', '');
    res.redirect('/admin/settings?msg=Settings updated!');
});

// Admin settings page (GET)
router.get('/settings', requireLogin, async (req, res) => {
    const settings = await getSettingsWithDefaults();
    const backups = await backupUtils.listBackups();
    res.render('admin-settings', {
        req,
        settings,
        serverBackups: backups,
        backupLimit: backupUtils.BACKUP_LIMIT_BYTES,
        showAdminNav: req.session && req.session.loggedIn,
        loggedIn: req.session && req.session.loggedIn,
        msg: req.query.msg || null
    });
});

// Remove header image
router.post('/settings/remove-header-image', requireLogin, async (req, res) => {
    const currentHeaderImage = getSetting('headerImage');
    if (currentHeaderImage) {
        const filePath = path.join(brandingDir, currentHeaderImage);
        try {
            await fs.promises.access(filePath);
            fs.unlinkSync(filePath);
        } catch (err) {
            // Ignore error if file does not exist
        }
        fs.unlink(filePath, (unlinkErr) => {
            if (unlinkErr) {
                // Handle unlink error if needed
            }
        });
    }
});

// Move the following route definitions outside of the `/settings/remove-header-image` handler
router.get('/manage', requireLogin, async (req, res) => {
    const categories = await getCategoriesWithImages();
    const settings = await getSettingsWithDefaults();
    res.render('admin-manage', {
        categories,
        req,
        settings,
        showAdminNav: req.session && req.session.loggedIn,
        loggedIn: req.session && req.session.loggedIn
    });
});

router.get('/users', requireLogin, (req, res) => {
    const { getDb, ready } = require('../db');
    (async () => {
        await ready;
        const db = getDb();
        const admins = db.prepare('SELECT id, username FROM admin').all();
        const currentAdmin = req.session.adminId;
        const settings = getSettingsWithDefaults();
        res.render('admin-users', {
            admins,
            currentAdmin,
            req,
            settings,
            showAdminNav: req.session && req.session.loggedIn,
            loggedIn: req.session && req.session.loggedIn,
            _: _ // Pass lodash to template
        });
    })();
});

// Create new admin
router.post('/users/create', requireLogin, async (req, res) => {
    const { getDb, ready } = require('../db');
    await ready;
    const db = getDb();
    let username = typeof req.body.username === 'string' ? validator.trim(req.body.username) : '';
    username = validator.escape(username).slice(0, 32);
    let password = typeof req.body.password === 'string' ? req.body.password : '';
    password = validator.stripLow(password, true).slice(0, 64);
    if (!username || !password || username.length < 3 || password.length < 8) {
        return res.redirect('/admin/users?msg=Username and password required (min 3/8 chars)');
    }
    try {
        db.prepare('INSERT INTO admin (username, hash) VALUES (?, ?)').run(
            username,
            await bcrypt.hash(password, 10)
        );
        res.redirect('/admin/users?msg=Admin account created!');
    } catch (e) {
        if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.redirect('/admin/users?msg=Username already taken');
        }
        res.redirect('/admin/users?msg=Failed to create admin');
    }
});

// Change own credentials
router.post('/users/change-credentials', requireLogin, async (req, res) => {
    const { getDb, ready } = require('../db');
    await ready;
    const db = getDb();
    let newUsername = typeof req.body.newUsername === 'string' ? validator.trim(req.body.newUsername) : '';
    newUsername = validator.escape(newUsername).slice(0, 32);
    let currentPassword = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
    let newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';
    if (!newUsername || !currentPassword || !newPassword) {
        return res.redirect('/admin/users?msg=All fields are required');
    }
    if (newUsername.length < 3 || newPassword.length < 8) {
        return res.redirect('/admin/users?msg=Username or password too short');
    }
    const admin = db.prepare('SELECT * FROM admin WHERE id = ?').get(req.session.adminId);
    if (!(await bcrypt.compare(currentPassword, admin.hash))) {
        return res.redirect('/admin/users?msg=Current password incorrect');
    }
    try {
        db.prepare('UPDATE admin SET username = ?, hash = ? WHERE id = ?')
            .run(newUsername, await bcrypt.hash(newPassword, 10), admin.id);
        req.session.destroy(() => {
            res.redirect('/login?msg=Credentials updated. Please log in again.');
        });
    } catch (e) {
        if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.redirect('/admin/users?msg=Username already taken');
        }
        res.redirect('/admin/users?msg=Failed to update credentials');
    }
});

// Change own username
router.post('/users/change-username', requireLogin, async (req, res) => {
    const { getDb, ready } = require('../db');
    await ready;
    const db = getDb();
    let newUsername = typeof req.body.newUsername === 'string' ? validator.trim(req.body.newUsername) : '';
    newUsername = validator.escape(newUsername).slice(0, 32);
    let currentPassword = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
    if (!newUsername || !currentPassword) {
        return res.redirect('/admin/users?msg=All fields are required');
    }
    if (newUsername.length < 3) {
        return res.redirect('/admin/users?msg=Username too short');
    }
    const admin = db.prepare('SELECT * FROM admin WHERE id = ?').get(req.session.adminId);
    if (!(await bcrypt.compare(currentPassword, admin.hash))) {
        return res.redirect('/admin/users?msg=Current password incorrect');
    }
    try {
        db.prepare('UPDATE admin SET username = ? WHERE id = ?')
            .run(newUsername, admin.id);
        req.session.destroy(() => {
            res.redirect('/login?msg=Username updated. Please log in again.');
        });
    } catch (e) {
        if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.redirect('/admin/users?msg=Username already taken');
        }
        res.redirect('/admin/users?msg=Failed to update username');
    }
});

// Change own password
router.post('/users/change-password', requireLogin, async (req, res) => {
    const { getDb, ready } = require('../db');
    await ready;
    const db = getDb();
    let currentPassword = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
    let newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';
    if (!currentPassword || !newPassword) {
        return res.redirect('/admin/users?msg=All fields are required');
    }
    if (newPassword.length < 8) {
        return res.redirect('/admin/users?msg=Password too short');
    }
    const admin = db.prepare('SELECT * FROM admin WHERE id = ?').get(req.session.adminId);
    if (!(await bcrypt.compare(currentPassword, admin.hash))) {
        return res.redirect('/admin/users?msg=Current password incorrect');
    }
    try {
        db.prepare('UPDATE admin SET hash = ? WHERE id = ?')
            .run(await bcrypt.hash(newPassword, 10), admin.id);
        req.session.destroy(() => {
            res.redirect('/login?msg=Password updated. Please log in again.');
        });
    } catch (e) {
        res.redirect('/admin/users?msg=Failed to update password');
    }
});

// Optional: Delete another admin (prevent deleting self)
router.post('/users/delete', requireLogin, (req, res) => {
    const { getDb, ready } = require('../db');
    (async () => {
        await ready;
        const db = getDb();
        const { id } = req.body;
        if (!id || Number(id) === req.session.adminId) {
            return res.redirect('/admin/users?msg=Cannot delete your own account');
        }
        db.prepare('DELETE FROM admin WHERE id = ?').run(id);
        res.redirect('/admin/users?msg=Admin deleted');
    })();
});

// Admin: Serve client images (for admin upload page)
router.get('/client-images/:clientId/:filename', requireLogin, (req, res) => {
    const { getDb, ready } = require('../db');
    (async () => {
        await ready;
        const db = getDb();
        const { clientId, filename } = req.params;

        // Verify the image belongs to this client in the database
        const image = db.prepare('SELECT * FROM client_images WHERE client_id = ? AND filename = ?')
            .get(clientId, filename);

        if (!image) {
            return res.status(404).send('Image not found');
        }

        const filePath = path.join(CLIENT_UPLOADS_DIR, clientId.toString(), filename);

        if (fs.existsSync(filePath)) {
            res.sendFile(filePath);
        } else {
            res.status(404).send('Image not found');
        }
    })();
});

// Admin: Client management page
router.get('/clients', requireLogin, (req, res) => {
    const clients = getAllClients();
    const settings = getSettingsWithDefaults();
    res.render('admin-clients', {
        clients,
        settings,
        req,
        showAdminNav: true,
        loggedIn: true
    });
});

// Admin: Create new client page
router.get('/clients/new', requireLogin, (req, res) => {
    const settings = getSettingsWithDefaults();
    res.render('admin-client-new', {
        settings,
        req,
        showAdminNav: true,
        loggedIn: true
    });
});

// Admin: Create new client
router.post('/clients/create', requireLogin, async (req, res) => {
    let clientName = typeof req.body.clientName === 'string' ? validator.trim(req.body.clientName) : '';
    clientName = validator.escape(clientName).slice(0, 100);
    let shootTitle = typeof req.body.shootTitle === 'string' ? validator.trim(req.body.shootTitle) : '';
    shootTitle = validator.escape(shootTitle).slice(0, 100);
    let password = typeof req.body.password === 'string' ? req.body.password : '';
    password = validator.stripLow(password, true).slice(0, 50);
    let customExpiry = req.body.customExpiry;
    if (customExpiry && !validator.isISO8601(customExpiry)) customExpiry = null;
    if (!clientName || !password) {
        return res.redirect('/admin/clients/new?msg=Name and password required');
    }
    try {
        const expiryDate = customExpiry ? new Date(customExpiry) : null;
        const result = await createClient(clientName, shootTitle, password, expiryDate);
        res.redirect(`/admin/clients/${result.id}/upload?created=true&code=${result.accessCode}`);
    } catch (err) {
        console.error('Error creating client:', err);
        res.redirect('/admin/clients/new?msg=Failed to create client');
    }
});

// Admin: Upload images for client (with multer)
const clientStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        const clientDir = path.join(CLIENT_UPLOADS_DIR, req.params.clientId);
        if (!fs.existsSync(clientDir)) {
            fs.mkdirSync(clientDir, { recursive: true });
        }
        cb(null, clientDir);
    },
    filename: function (req, file, cb) {
        const timestamp = Date.now();
        const ext = path.extname(file.originalname);
        cb(null, `${timestamp}-${uuidv4()}${ext}`);
    }
});
const clientUpload = multer({
    storage: clientStorage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files allowed'), false);
        }
    },
    limits: { fileSize: 50 * 1024 * 1024 }
});

router.get('/clients/:clientId/upload', requireLogin, async (req, res) => {
    try {
        const clientId = req.params.clientId;
        const clientData = getClientById(clientId);
        if (!clientData) {
            return res.status(404).send('Client not found');
        }
        const images = await getClientImages(clientId);
        const settings = await getSettingsWithDefaults();
        res.render('admin-client-upload', {
            clientData,
            images,
            settings,
            req,
            showAdminNav: true,
            loggedIn: true,
            _: _ // Pass lodash to template
        });
    } catch (error) {
        console.error('Error in route:', error);
        res.status(500).send('Error: ' + error.message);
    }
});

router.post('/clients/:clientId/upload', requireLogin, clientUpload.array('images', 50), async (req, res) => {
    const clientId = req.params.clientId;
    if (req.files) {
        for (const file of req.files) {
            const isImage = await isRealImage(file.path);
            if (!isImage) {
                fs.unlinkSync(file.path);
                return res.status(400).send('Invalid file type uploaded.');
            }
            addClientImage(clientId, file.filename, file.originalname, file.size);
        }
    }
    res.redirect(`/admin/clients/${clientId}/upload?uploaded=${req.files ? req.files.length : 0}`);
});

// Admin: Upload images (multiple files, protected) -- RATE LIMITED
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // Always upload to a temp directory first
        const tempDir = path.join(__dirname, '../data/tmp');
        fs.mkdirSync(tempDir, { recursive: true });
        cb(null, tempDir);
    },
    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname);
        cb(null, uuidv4() + ext);
    }
});
const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
            return cb(new Error('Only image files are allowed!'), false);
        }
        cb(null, true);
    },
    limits: { fileSize: 10 * 1024 * 1024 }
});

router.post('/upload', requireLogin, adminLimiter, upload.array('images', 20), async (req, res, next) => {
    try {
        const category = req.body.category;
        if (!category) {
            return res.status(400).send('No category selected. Please select a category before uploading.');
        }
        if (!isSafeCategory(category)) {
            return res.status(400).send('Invalid category');
        }
        const destDir = path.join(__dirname, '../data/images', category);
        fs.mkdirSync(destDir, { recursive: true });
        const catInfo = await getCategoryIdAndMaxPosition(category);
        let maxPos = catInfo ? catInfo.maxPos : 0;
        for (const file of req.files) {
            const isImage = await isRealImage(file.path);
            if (!isImage) {
                fs.unlinkSync(file.path);
                return res.status(400).send('Invalid file type uploaded.');
            }
            const tmpPath = file.path;
            const destPath = path.join(destDir, file.filename);
            fs.renameSync(tmpPath, destPath);
            await addImage(category, file.filename, ++maxPos, '');
        }
        return res.redirect('/admin/manage?msg=Upload successful!');
    } catch (err) {
        next(err);
    }
});

// Admin: Delete client image
router.post('/clients/:clientId/images/:imageId/delete', requireLogin, (req, res) => {
    const { clientId, imageId } = req.params;
    deleteClientImage(parseInt(clientId), parseInt(imageId));
    res.redirect(`/admin/clients/${clientId}/upload?deleted=true`);
});

// Bulk delete client images
router.post('/clients/:clientId/images/bulk-delete', requireLogin, (req, res) => {
    const { clientId } = req.params;
    let imageIds = req.body.imageIds;
    if (!imageIds) return res.redirect(`/admin/clients/${clientId}/upload?msg=No images selected`);
    imageIds = imageIds.split(',').filter(Boolean);
    imageIds.forEach(id => deleteClientImage(parseInt(clientId), parseInt(id)));
    res.redirect(`/admin/clients/${clientId}/upload?msg=Deleted ${imageIds.length} photo(s)!`);
});

// Admin: Delete client
router.post('/clients/:id/delete', requireLogin, (req, res) => {
    const clientId = req.params.id;
    deleteClient(clientId);
    res.redirect('/admin/clients?msg=Client deleted');
});

// Admin: Toggle client status
router.post('/clients/:id/toggle', requireLogin, (req, res) => {
    const clientId = req.params.id;
    toggleClientStatus(clientId);
    res.redirect('/admin/clients?msg=Client status updated');
});

// Create category -- RATE LIMITED
router.post('/create-category', requireLogin, adminLimiter, async (req, res) => {
    let newCategory = req.body.newCategory || '';
    try {
        // Let createCategory handle normalization and validation
        await createCategory(newCategory);
        // Invalidate cache so new category appears immediately
        const { invalidateCategoryCache } = require('../utils/categoryCache');
        invalidateCategoryCache();
        return res.redirect('/admin/manage?msg=Category created!');
    } catch (err) {
        return res.redirect('/admin/manage?msg=' + encodeURIComponent(err.message || 'Failed to create category'));
    }
});

// Delete category -- RATE LIMITED
router.post('/delete-category', requireLogin, adminLimiter, async (req, res) => {
    const category = req.body.category;
    if (!isSafeCategory(category)) return res.redirect('/admin/manage?msg=Invalid category!');
    if (categoryExists(category)) {
        deleteCategory(category);
        // Remove folder from filesystem
        const catDir = path.join(__dirname, '../public/images', category);
        if (fs.existsSync(catDir)) fs.rmSync(catDir, { recursive: true, force: true });
        // Optionally invalidate cache if you use one
        return res.redirect('/admin/manage?msg=Category deleted!');
    } else {
        return res.redirect('/admin/manage?msg=Category not found!');
    }
});

// Rename category -- RATE LIMITED
router.post('/rename-category', requireLogin, adminLimiter, async (req, res) => {
    const { oldName, newName } = req.body;
    if (!isSafeCategory(oldName) || !isSafeCategory(newName)) {
        return res.redirect('/admin/manage?msg=Invalid category name!');
    }
    if (!categoryExists(oldName)) {
        return res.redirect('/admin/manage?msg=Original category not found!');
    }
    if (categoryExists(newName)) {
        return res.redirect('/admin/manage?msg=Category name already exists!');
    }
    // Update category name in DB
    const { getDb, ready } = require('../db');
    await ready;
    const db = getDb();
    db.prepare('UPDATE categories SET name = ? WHERE name = ?').run(newName, oldName);
    // Rename folder on disk if exists
    const oldDir = path.join(__dirname, '../public/images', oldName);
    const newDir = path.join(__dirname, '../public/images', newName);
    if (fs.existsSync(oldDir)) {
        fs.renameSync(oldDir, newDir);
    }
    // Optionally invalidate cache if you use one
    return res.redirect('/admin/manage?msg=Category renamed!');
});

// Reorder images -- RATE LIMITED
router.post('/reorder-images', requireLogin, adminLimiter, async (req, res) => {
    const { category, order } = req.body;
    if (!isSafeCategory(category)) return res.redirect('/admin/manage?msg=Invalid category!');
    let orderArr;
    try {
        orderArr = JSON.parse(order);
        if (!Array.isArray(orderArr)) throw new Error();
    } catch {
        return res.redirect('/admin/manage?msg=Invalid order data!');
    }
    saveImageOrder(category, orderArr);
    // Optionally invalidate cache if you use one
    return res.redirect('/admin/manage?msg=Order saved!');
});

// Reorder categories -- RATE LIMITED
router.post('/reorder-categories', requireLogin, adminLimiter, async (req, res) => {
    const { order } = req.body; // order is an array of category names
    if (!Array.isArray(order)) return res.status(400).json({ error: 'Invalid order' });
    const { getDb, ready } = require('../db');
    await ready;
    const db = getDb();
    order.forEach((catName, idx) => {
        db.prepare('UPDATE categories SET position = ? WHERE name = ?').run(idx, catName);
    });
    // Optionally invalidate cache if you use one
    res.json({ success: true });
});

// Set category thumbnail -- RATE LIMITED
router.post('/set-thumbnail', requireLogin, adminLimiter, async (req, res) => {
    const { category, filename } = req.body;
    if (!isSafeCategory(category) || !filename || filename.includes('/') || filename.includes('\\')) {
        return res.status(400).json({ error: 'Invalid request' });
    }
    const filePath = path.join(__dirname, '../public/images', category, filename);
    if (!fs.existsSync(filePath)) {
        return res.status(400).json({ error: 'Image not found' });
    }
    setCategoryThumbnail(category, filename);
    // Optionally invalidate cache if you use one
    return res.json({ success: true });
});

// Update alt text for an image -- RATE LIMITED
router.post('/update-alt-text', requireLogin, adminLimiter, (req, res) => {
    const { imageId, altText } = req.body;
    if (!imageId) return res.status(400).json({ error: 'Missing image ID' });
    updateAltText(imageId, altText);
    res.json({ success: true });
});

// Move image to another category -- RATE LIMITED
router.post('/move-image', requireLogin, adminLimiter, async (req, res) => {
    const { filenames, fromCategory, toCategory } = req.body;
    if (
        !isSafeCategory(fromCategory) ||
        !isSafeCategory(toCategory) ||
        !Array.isArray(filenames) ||
        filenames.some(f => !f || f.includes('/') || f.includes('\\'))
    ) {
        return res.status(400).json({ error: 'Invalid request' });
    }
    if (!categoryExists(toCategory)) {
        return res.status(400).json({ error: 'Destination category does not exist' });
    }
    const destDir = path.join(__dirname, '../public/images', toCategory);
    fs.mkdirSync(destDir, { recursive: true });
    let maxPos = 0;
    try {
        const result = getMaxImagePosition(toCategory);
        maxPos = typeof result === 'number' && result >= 0 ? result : 0;
    } catch (error) {
        console.error(`Error fetching max image position for category "${toCategory}":`, error);
    }
    let moved = 0;
    for (const filename of filenames) {
        const srcPath = path.join(__dirname, '../public/images', fromCategory, filename);
        const destPath = path.join(destDir, filename);
        if (!fs.existsSync(srcPath)) continue;
        fs.renameSync(srcPath, destPath);
        deleteImage(fromCategory, filename);
        addImage(toCategory, filename, ++maxPos, '');
        moved++;
    }
    // Optionally invalidate cache if you use one
    return res.json({ success: true, moved });
});

// Delete image route (protected) -- RATE LIMITED
router.post('/delete-image', requireLogin, adminLimiter, async (req, res) => {
    const { category, filename } = req.body;
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        return res.status(400).send('Invalid filename');
    }
    if (!isSafeCategory(category) || !filename || filename.includes('/') || filename.includes('\\')) {
        return res.status(400).json({ error: 'Invalid request' });
    }
    // Remove file from filesystem
    const filePath = path.join(__dirname, '../public/images', category, filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    deleteImage(category, filename);
    // Optionally invalidate cache if you use one
    return res.sendStatus(200);
});

// Bulk delete images route (protected) -- RATE LIMITED
router.post('/bulk-delete-images', requireLogin, adminLimiter, async (req, res) => {
    const { category, filenames } = req.body;
    if (!isSafeCategory(category) || !Array.isArray(filenames)) {
        return res.status(400).json({ error: 'Invalid request' });
    }
    for (const filename of filenames) {
        const filePath = path.join(__dirname, '../public/images', category, filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        deleteImage(category, filename);
    }
    // Optionally invalidate cache if you use one
    return res.json({ deleted: filenames });
});

// Admin About editor (GET)
router.get('/about', requireLogin, async (req, res) => {
    const about = await getAbout();
    const settings = getSettingsWithDefaults();
    res.render('admin-about', {
        about,
        req,
        settings,
        showAdminNav: req.session && req.session.loggedIn,
        loggedIn: req.session && req.session.loggedIn
    });
});

// Update About bio (markdown only)
router.post('/about/bio', requireLogin, async (req, res) => {
    const markdown = req.body.markdown || '';
    await updateAbout(markdown);
    res.redirect('/admin/about?msg=Bio saved!');
});

// About image upload (with multer)
const aboutUpload = multer({ dest: path.join(__dirname, '../data/') });
router.post('/about/image', requireLogin, aboutUpload.single('image'), async (req, res) => {
    let imagePath = req.body.currentImage;
    if (req.file) {
        imagePath = req.file.filename;
    }
    const about = await getAbout();
    await updateAbout(about.markdown || '', imagePath);
    res.redirect('/admin/about?msg=Image saved!');
});

router.post('/about/delete-image', requireLogin, async (req, res) => {
    await deleteAboutImage();
    res.redirect('/admin/about?msg=Image deleted!');
});

// Admin: Backup and restore routes (GET, POST, download, delete, bulk-action, restore, restore-selected)
const BACKUP_DIR = path.join(__dirname, '../data/backups');
const backupUpload = multer({ dest: BACKUP_DIR });

// GET: List all backups
router.get('/backup', requireLogin, (req, res) => {
    const backups = backupUtils.listBackups();
    const settings = getSettingsWithDefaults();
    res.render('admin-settings', {
        req,
        settings,
        serverBackups: backups,
        backupLimit: backupUtils.BACKUP_LIMIT_BYTES,
        showAdminNav: req.session && req.session.loggedIn,
        loggedIn: req.session && req.session.loggedIn,
        msg: req.query.msg || null
    });
});

// POST: Create a new backup
router.post('/backup', requireLogin, async (req, res) => {
    try {
        await backupUtils.createBackup();
        res.redirect('/admin/settings?msg=Backup created!');
    } catch (err) {
        res.redirect('/admin/settings?msg=Backup failed: ' + err.message);
    }
});

// GET: Download a backup file
router.get('/backup/download/:filename', requireLogin, (req, res) => {
    const { filename } = req.params;
    if (!/^[\w.-]+\.zip$/.test(filename)) return res.status(400).send('Invalid filename');
    const filePath = path.join(backupUtils.BACKUP_DIR, filename);
    if (!fs.existsSync(filePath)) return res.status(404).send('Backup not found');
    res.download(filePath, filename);
});

// POST: Delete a backup file
router.post('/backup/delete/:filename', requireLogin, (req, res) => {
    const { filename } = req.params;
    try {
        if (backupUtils.deleteBackup(filename)) {
            res.redirect('/admin/settings?msg=Backup deleted');
        } else {
            res.redirect('/admin/settings?msg=Backup not found');
        }
    } catch {
        res.redirect('/admin/settings?msg=Invalid filename');
    }
});

// POST: Bulk backup action (delete or download)
router.post('/backup/bulk-action', requireLogin, async (req, res) => {
    const { action, filenames } = req.body;
    if (!Array.isArray(filenames) || !filenames.length) {
        return res.redirect('/admin/settings?msg=No backups selected');
    }
    if (action === 'delete') {
        const deleted = await backupUtils.bulkDeleteBackups(filenames);
        return res.redirect(`/admin/settings?msg=Deleted ${deleted} backup(s)`);
    } else if (action === 'download') {
        try {
            const { archivePath, archiveName } = await backupUtils.bulkDownloadBackups(filenames);
            res.download(archivePath, archiveName, err => {
                fs.unlinkSync(archivePath);
            });
        } catch (err) {
            res.redirect('/admin/settings?msg=Bulk download failed: ' + err.message);
        }
    } else {
        res.redirect('/admin/settings?msg=Invalid action');
    }
});

// POST: Restore from uploaded backup file
router.post('/restore', requireLogin, backupUpload.single('backupFile'), async (req, res) => {
    if (!req.file) return res.redirect('/admin/settings?msg=No file uploaded');
    try {
        await backupUtils.restoreBackup(req.file.path);
        fs.unlinkSync(req.file.path);
        res.redirect('/admin/settings?msg=Backup restored!');
    } catch (err) {
        res.redirect('/admin/settings?msg=Failed to restore: ' + err.message);
    }
});

// POST: Restore from selected backup file
router.post('/restore-selected', requireLogin, async (req, res) => {
    const { filename } = req.body;
    if (!/^[\w.-]+\.zip$/.test(filename)) return res.redirect('/admin/settings?msg=Invalid filename');
    const filePath = path.join(backupUtils.BACKUP_DIR, filename);
    if (!fs.existsSync(filePath)) return res.redirect('/admin/settings?msg=Backup not found');
    try {
        await backupUtils.restoreBackup(filePath);
        res.redirect('/admin/settings?msg=Backup restored!');
    } catch (err) {
        res.redirect('/admin/settings?msg=Failed to restore: ' + err.message);
    }
});

// ...more /admin routes can be moved here...

module.exports = router;
