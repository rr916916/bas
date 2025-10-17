// srv/service.js
const cds = require('@sap/cds');

module.exports = cds.service.impl(async function() {
  const LOG = cds.log('service');

  LOG.info('Registering Invoice Service handlers');

  // Import all handlers
  const workflowHandler = require('./handlers/workflow');
  const invoiceHandler = require('./handlers/invoice');
  const supplierHandler = require('./handlers/supplier');
  const supplierUtilsHandler = require('./handlers/supplier-utils');
  const poMatcherHandler = require('./handlers/po-matcher');
  const sapPostingHandler = require('./handlers/sap-posting');

  // Register all handlers
  LOG.info('Registering workflow handler...');
  workflowHandler(this);
  
  LOG.info('Registering invoice handler...');
  invoiceHandler(this);
  
  LOG.info('Registering supplier handler...');
  supplierHandler(this);
  
  LOG.info('Registering supplier utils handler...');
  supplierUtilsHandler(this);
  
  LOG.info('Registering PO matcher handler...');
  poMatcherHandler(this);
  
  LOG.info('Registering SAP posting handler...');
  sapPostingHandler(this);

  // ============================================
  // GLOBAL ERROR HANDLER
  // ============================================
  this.on('error', (err, req) => {
    LOG.error('Service error:', {
      error: err.message,
      code: err.code,
      action: req.event,
      user: req.user?.id
    });
    
    // Map technical errors to user-friendly messages
    if (err.code === 'ECONNREFUSED') {
      req.error(503, 'SAP system unavailable. Please try again later.');
    } else if (err.statusCode === 401 || err.code === 401) {
      req.error(401, 'Authentication failed. Please check credentials.');
    } else if (err.code === 'ETIMEDOUT') {
      req.error(504, 'SAP system timeout. Please try again.');
    } else if (err.code === 'ENOTFOUND') {
      req.error(503, 'SAP system not reachable. Check destination configuration.');
    } else if (err.code === 'ENTITY_NOT_FOUND') {
      req.error(404, 'Resource not found');
    }
  });

  // ============================================
  // REQUEST LOGGING
  // ============================================
  this.before('*', (req) => {
    // Skip logging for CRUD operations
    if (['CREATE', 'UPDATE', 'DELETE', 'READ'].includes(req.event)) {
      return;
    }
    
    const action = req.event;
    const params = Object.keys(req.data || {}).length > 0 
      ? `with ${Object.keys(req.data).join(', ')}` 
      : '';

    LOG.info(`[ACTION] ${action} ${params}`, { 
      user: req.user?.id || 'anonymous'
    });
  });

  // ============================================
  // RESPONSE LOGGING
  // ============================================
  this.after('*', (result, req) => {
    // Skip logging for CRUD operations
    if (['CREATE', 'UPDATE', 'DELETE', 'READ'].includes(req.event)) {
      return;
    }
    
    const action = req.event;
    
    LOG.info(`[ACTION] ${action} completed`, {
      success: true,
      resultType: typeof result
    });
  });

  // ============================================
  // HEALTH CHECK
  // ============================================
  this.on('HealthCheck', async () => {
    LOG.info('Health check requested');
    
    const health = {
      status: 'UP',
      timestamp: new Date().toISOString(),
      services: {
        database: 'UNKNOWN',
        embeddings: 'UNKNOWN'
      }
    };

    // Check database
    try {
      await cds.db.run('SELECT 1 FROM DUMMY');
      health.services.database = 'UP';
    } catch (e) {
      health.services.database = 'DOWN';
      health.status = 'DEGRADED';
    }

    // Check embeddings
    try {
      const MODEL = process.env.EMBEDDINGS_MODEL || 'SAP_GXY.20250407';
      await cds.db.run(`SELECT VECTOR_EMBEDDING('test', 'QUERY', ?) FROM DUMMY`, [MODEL]);
      health.services.embeddings = 'UP';
    } catch (e) {
      health.services.embeddings = 'DOWN';
      LOG.warn('Embeddings service unavailable');
    }

    return health;
  });

  LOG.info('Invoice Service initialization complete');
  LOG.info('Registered handlers: workflow, invoice, supplier, supplier-utils, po-matcher, sap-posting');
});