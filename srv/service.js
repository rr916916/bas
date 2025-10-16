// srv/service.js
const cds = require('@sap/cds');

const invoiceHandler = require('./handlers/invoice');
const supplierHandler = require('./handlers/supplier');
const poMatcherHandler = require('./handlers/po-matcher');
const sapPostingHandler = require('./handlers/sap-posting');

module.exports = cds.service.impl(async function() {
  const LOG = cds.log('service');

  // Register all handlers
  invoiceHandler(this);
  supplierHandler(this);
  poMatcherHandler(this);
  sapPostingHandler(this);

  // Global error handler
  this.on('error', (err, req) => {
    LOG.error('Service error:', err);
    
    // Map technical errors to user-friendly messages
    if (err.code === 'ECONNREFUSED') {
      req.error(503, 'SAP system unavailable. Please try again later.');
    } else if (err.statusCode === 401) {
      req.error(401, 'Authentication failed. Please check credentials.');
    } else if (err.code === 'ETIMEDOUT') {
      req.error(504, 'SAP system timeout. Please try again.');
    } else if (err.code === 'ENOTFOUND') {
      req.error(503, 'SAP system not reachable. Check destination configuration.');
    }
  });

  // Log all action calls for debugging
  this.before('*', (req) => {
    if (['CREATE', 'UPDATE', 'DELETE', 'READ'].includes(req.event)) {
      return; // Skip CRUD operations
    }
    
    const actionName = req.event;
    LOG.info(`[ACTION] ${actionName} called`, { 
      user: req.user?.id || 'anonymous',
      params: req.data 
    });
  });

  // Log action results
  this.after('*', (result, req) => {
    if (['CREATE', 'UPDATE', 'DELETE', 'READ'].includes(req.event)) {
      return;
    }
    
    const actionName = req.event;
    LOG.info(`[ACTION] ${actionName} completed`, {
      success: true,
      result: typeof result === 'object' ? Object.keys(result) : result
    });
  });
});