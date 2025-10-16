// srv/utils/validation.js

/**
 * Validate supplier match quality
 */
function validateSupplierMatch(score) {
  if (score >= 0.9) {
    return { valid: true, confidence: 'HIGH', requiresReview: false };
  } else if (score >= 0.75) {
    return { valid: true, confidence: 'MEDIUM', requiresReview: false };
  } else if (score >= 0.6) {
    return { valid: true, confidence: 'LOW', requiresReview: true };
  } else {
    return { valid: false, confidence: 'VERY_LOW', requiresReview: true };
  }
}

/**
 * Validate PO item match
 */
function validatePOItemMatch(doxItem, poItem, matchScore) {
  const issues = [];

  if (matchScore < 0.7) {
    issues.push('Match confidence too low');
  }

  if (poItem.OpenQuantity <= 0) {
    issues.push('No open quantity on PO');
  }

  if (poItem.InvoiceIsGoodsReceiptBased && !poItem.GrQuantityPosted) {
    issues.push('GR not posted for GR-based invoice');
  }

  // Price variance check (10% tolerance)
  if (doxItem.unitPrice && poItem.NetPriceAmount) {
    const variance = Math.abs((doxItem.unitPrice - poItem.NetPriceAmount) / poItem.NetPriceAmount);
    if (variance > 0.1) {
      issues.push(`Price variance: ${(variance * 100).toFixed(1)}%`);
    }
  }

  return {
    valid: issues.length === 0,
    issues
  };
}

/**
 * Validate invoice readiness for posting
 */
function validateInvoiceForPosting(header) {
  const errors = [];

  if (!header.matchedSupplierNumber) {
    errors.push('Supplier not matched');
  }

  if (!header.netAmount || header.netAmount <= 0) {
    errors.push('Invalid net amount');
  }

  if (!header.companyCode) {
    errors.push('Company code missing');
  }

  if (!header.currencyCode) {
    errors.push('Currency missing');
  }

  if (!header.documentDate) {
    errors.push('Document date missing');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

module.exports = {
  validateSupplierMatch,
  validatePOItemMatch,
  validateInvoiceForPosting
};