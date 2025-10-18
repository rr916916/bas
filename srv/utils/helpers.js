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
 * Parse OData V2 date format: /Date(1234567890000)/
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
 * Format date for SAP OData V2: /Date(timestamp)/
 */
function formatDateForSAPOData(dateValue) {
  if (!dateValue) return null;
  
  let date;
  if (typeof dateValue === 'string') {
    date = new Date(dateValue);
  } else if (dateValue instanceof Date) {
    date = dateValue;
  } else {
    return null;
  }

  if (isNaN(date.getTime())) return null;

  // SAP OData v2 expects: /Date(timestamp)/
  const timestamp = date.getTime();
  return `/Date(${timestamp})/`;
}

/**
 * Format date for SAP (YYYY-MM-DD) - for non-OData APIs
 */
function formatDateForSAP(date) {
  if (!date) return null;
  if (typeof date === 'string') date = new Date(date);
  if (isNaN(date.getTime())) return null;
  return date.toISOString().split('T')[0];
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
    message: truncate(message, 500),
    details: details ? JSON.stringify(details) : null,
    modifiedBy: cds.context?.user?.id || 'SYSTEM'
  }));
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
 * Safe boolean conversion - handles SAP's 'X' and true/false
 */
function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  return value === 'X' || value === 'x' || value === true || 
         value === 1 || value === '1' || value === 'true';
}

/**
 * Truncate string to max length safely
 */
function truncate(value, maxLength) {
  if (!value) return '';
  return String(value).substring(0, maxLength);
}

/**
 * Get physical HANA table name from namespace and entity
 * Example: ('juno_invoice_assistant_v1', 'SAPPOItem') => 'JUNO_INVOICE_ASSISTANT_V1_SAPPOITEM'
 */
function getPhysicalTableName(namespace, entityName) {
  return `${namespace}_${entityName}`.toUpperCase();
}

/**
 * Build URL with query parameters
 */
function buildUrl(path, params) {
  const url = new URL('http://dummy' + path);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, value);
    }
  });
  return url.pathname + url.search;
}

/**
 * Generate UUID
 */
function generateUUID() {
  return cds.utils.uuid();
}

/**
 * Safely extract SAP error message from various error response formats
 */
function extractSAPError(error) {
  // Try different error response structures
  const errorData = error.response?.data || error;
  
  // OData v2 error structure
  if (errorData?.error?.message?.value) {
    return errorData.error.message.value;
  }
  
  // OData v4 error structure
  if (errorData?.error?.message) {
    return errorData.error.message;
  }
  
  // Inner error details
  if (errorData?.error?.innererror?.errordetails?.[0]?.message) {
    return errorData.error.innererror.errordetails[0].message;
  }
  
  // Fallback to basic error message
  return error.message || 'Unknown SAP error';
}

/**
 * Validate required fields
 * @param {Object} data - Data object to validate
 * @param {Array} requiredFields - Array of field names that are required
 * @returns {Object} - {valid: boolean, missing: string[]}
 */
function validateRequiredFields(data, requiredFields) {
  const missing = [];
  
  for (const field of requiredFields) {
    if (!data[field] && data[field] !== 0) {
      missing.push(field);
    }
  }
  
  return {
    valid: missing.length === 0,
    missing
  };
}

module.exports = {
  parseJSON,
  parseODataV2Date,
  formatDateForSAPOData,
  formatDateForSAP,
  logProcess,
  toNumber,
  toBoolean,
  truncate,
  getPhysicalTableName,
  buildUrl,
  generateUUID,
  extractSAPError,
  validateRequiredFields
};