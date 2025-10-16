// srv/utils/helpers.js
const cds = require('@sap/cds');

/**
 * Parse JSON string safely
 */
function parseJSON(jsonString) {
  if (!jsonString) return null;
  
  if (typeof jsonString === 'object') {
    return jsonString;
  }

  try {
    return JSON.parse(jsonString);
  } catch (error) {
    const LOG = cds.log('utils');
    LOG.error('Failed to parse JSON:', error);
    return null;
  }
}

/**
 * Parse OData V2 date format
 */
function parseODataV2Date(val) {
  if (!val || typeof val !== 'string') return null;

  const match = /\/Date\((\-?\d+)([+-]\d{4})?\)\//.exec(val);
  if (!match) return null;

  const ms = Number(match[1]);
  if (!Number.isFinite(ms)) return null;

  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Log process step to InvoiceProcessLog
 */
async function logProcess(tx, headerId, step, status, result, message, details = null) {
  const { InvoiceProcessLog } = cds.entities('juno_invoice_assistant_v1');

  await tx.run(INSERT.into(InvoiceProcessLog).entries({
    invoiceHeader_ID: headerId,
    step,
    status,
    result,
    message,
    details: details ? JSON.stringify(details) : null,
    modifiedBy: cds.context?.user?.id || 'SYSTEM'
  }));
}

/**
 * Format date for SAP (YYYY-MM-DD)
 */
function formatDateForSAP(date) {
  if (!date) return null;
  if (typeof date === 'string') date = new Date(date);
  return date.toISOString().split('T')[0];
}

/**
 * Safe number conversion with decimals
 */
function toNumber(value, decimals = 2) {
  if (value === '' || value == null) return null;
  const num = Number(value);
  return Number.isNaN(num) ? null : Number(num.toFixed(decimals));
}

/**
 * Safe boolean conversion
 */
function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  return value === 'X' || value === 'x' || value === true || 
         value === 1 || value === '1' || value === 'true';
}

/**
 * Generate UUID
 */
function generateUUID() {
  return cds.utils.uuid();
}

module.exports = {
  parseJSON,
  parseODataV2Date,
  logProcess,
  formatDateForSAP,
  toNumber,
  toBoolean,
  generateUUID
};