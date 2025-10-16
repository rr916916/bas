// srv/handlers/invoice.js
const cds = require('@sap/cds');
const { parseJSON, logProcess } = require('../utils/helpers');

module.exports = function(srv) {
  const LOG = cds.log('invoice');
  const { InvoiceHeader, DOXInvoiceItem } = srv.entities;

  // ============================================
  // CREATE INVOICE FROM DOX
  // ============================================
  srv.on('CreateInvoiceFromDOX', async (req) => {
    const { data } = req.data;
    
    if (!data) {
      req.error(400, 'data is required');
      return;
    }

    const tx = cds.tx(req);
    
    try {
      // Parse JSON string
      const doxData = parseJSON(data);
      
      if (!doxData) {
        req.error(400, 'Invalid JSON data provided');
        return;
      }

      LOG.info('Creating invoice from DOX data', {
        fileName: doxData.fileName,
        invoiceNumber: doxData.documentNumber
      });

      // Extract header data
      const headerData = {
        correlationId: doxData.correlationId || cds.utils.uuid(),
        messageId: doxData.messageId || cds.utils.uuid(),
        step: 'DOX_EXTRACTED',
        status: 'IN_PROGRESS',
        sourceSystem: doxData.sourceSystem || 'DOX',
        
        // Document info
        fileName: doxData.fileName,
        pdfUrl: doxData.pdfUrl,
        repoId: doxData.repoId,
        objectId: doxData.objectId,
        mimeType: doxData.mimeType || 'application/pdf',
        size: doxData.size,
        doxJobId: doxData.doxJobId,
        doxConfidence: doxData.confidence,
        
        // DOX extracted fields
        paymentTerms: doxData.paymentTerms,
        receiverName: doxData.receiverName,
        senderName: doxData.senderName,
        senderAddress: doxData.senderAddress,
        receiverAddress: doxData.receiverAddress,
        documentDate: doxData.documentDate,
        dueDate: doxData.dueDate,
        currencyCode: doxData.currencyCode,
        grossAmount: doxData.grossAmount,
        netAmount: doxData.netAmount,
        taxAmount: doxData.taxAmount,
        taxName: doxData.taxName,
        taxRate: doxData.taxRate,
        
        // Address details
        senderCity: doxData.senderCity,
        receiverCity: doxData.receiverCity,
        senderState: doxData.senderState,
        receiverState: doxData.receiverState,
        senderPostalCode: doxData.senderPostalCode,
        receiverPostalCode: doxData.receiverPostalCode,
        senderExtraAddressPart: doxData.senderExtraAddressPart,
        receiverStreet: doxData.receiverStreet,
        receiverHouseNumber: doxData.receiverHouseNumber,
        
        // Document references
        documentNumber: doxData.documentNumber || doxData.invoiceNumber,
        purchaseOrderNumber: doxData.purchaseOrderNumber || doxData.poNumber,
        
        // Company code (from config or default)
        companyCode: doxData.companyCode || process.env.DEFAULT_COMPANY_CODE || '1000'
      };

      // Create header
      const result = await tx.run(
        INSERT.into(InvoiceHeader).entries(headerData)
      );

      const headerId = result.ID || headerData.ID;

      LOG.info(`Invoice header created: ${headerId}`);

      // Create DOX line items
      if (doxData.items && Array.isArray(doxData.items) && doxData.items.length > 0) {
        const lineItems = doxData.items.map((item, index) => ({
          invoiceHeader_ID: headerId,
          lineNumber: item.lineNumber || (index + 1),
          description: item.description,
          materialNumber: item.materialNumber || item.material,
          quantity: item.quantity,
          unitOfMeasure: item.unitOfMeasure || item.unit || item.uom,
          unitPrice: item.unitPrice,
          netAmount: item.netAmount || item.amount,
          taxAmount: item.taxAmount,
          taxCode: item.taxCode,
          matchStatus: 'PENDING'
        }));

        await tx.run(INSERT.into(DOXInvoiceItem).entries(lineItems));
        
        LOG.info(`Created ${lineItems.length} DOX line items`);
      }

      // Log process
      await logProcess(tx, headerId, 'DOX_EXTRACTED', 'COMPLETED', 'SUCCESS', 
        'Invoice created from DOX extraction', 
        { itemCount: doxData.items?.length || 0 });

      return {
        headerId,
        status: 'SUCCESS',
        message: `Invoice ${headerId} created successfully with ${doxData.items?.length || 0} items`
      };

    } catch (error) {
      LOG.error('Failed to create invoice from DOX:', error);
      req.error(500, `Failed to create invoice: ${error.message}`);
    }
  });

  // ============================================
  // VALIDATE FOR POSTING
  // ============================================
  srv.on('ValidateForPosting', async (req) => {
    const { headerId } = req.data;
    
    if (!headerId) {
      req.error(400, 'headerId is required');
      return;
    }

    const tx = cds.tx(req);

    const header = await tx.read(InvoiceHeader, headerId, h => {
      h('*'),
      h.doxItems('*'),
      h.poItems('*')
    });

    if (!header) {
      req.error(404, `Invoice ${headerId} not found`);
      return;
    }

    const errors = [];

    // Supplier validation
    if (!header.matchedSupplierNumber) {
      errors.push({
        field: 'supplier',
        message: 'Supplier not matched',
        severity: 'ERROR'
      });
    } else if (header.supplierMatchScore < 0.7) {
      errors.push({
        field: 'supplier',
        message: `Supplier match confidence low: ${(header.supplierMatchScore * 100).toFixed(1)}%`,
        severity: 'WARNING'
      });
    }

    // Amount validation
    if (!header.netAmount || header.netAmount <= 0) {
      errors.push({
        field: 'netAmount',
        message: 'Net amount is missing or invalid',
        severity: 'ERROR'
      });
    }

    // Company code
    if (!header.companyCode) {
      errors.push({
        field: 'companyCode',
        message: 'Company code is required',
        severity: 'ERROR'
      });
    }

    // Currency
    if (!header.currencyCode) {
      errors.push({
        field: 'currency',
        message: 'Currency code is required',
        severity: 'ERROR'
      });
    }

    // PO validation (if PO invoice)
    if (header.purchaseOrderNumber) {
      const doxItems = header.doxItems || [];
      const matchedCount = doxItems.filter(i => i.matchStatus === 'MATCHED').length;

      if (matchedCount === 0) {
        errors.push({
          field: 'poItems',
          message: 'No DOX items matched to PO items',
          severity: 'ERROR'
        });
      } else if (matchedCount < doxItems.length) {
        errors.push({
          field: 'poItems',
          message: `Only ${matchedCount} of ${doxItems.length} items matched`,
          severity: 'WARNING'
        });
      }

      // 3-way match validation
      if (header.threeWayMatchRequired && !header.grCheckPassed) {
        errors.push({
          field: 'goodsReceipt',
          message: '3-way match failed: Goods receipt not posted for all items',
          severity: 'ERROR'
        });
      }
    }

    // Document date
    if (!header.documentDate) {
      errors.push({
        field: 'documentDate',
        message: 'Document date is required',
        severity: 'ERROR'
      });
    }

    const hasErrors = errors.some(e => e.severity === 'ERROR');
    const hasWarnings = errors.some(e => e.severity === 'WARNING');

    let status = 'VALID';
    let message = 'Validation passed successfully';

    if (hasErrors) {
      status = 'INVALID';
      const errorCount = errors.filter(e => e.severity === 'ERROR').length;
      message = `Validation failed with ${errorCount} error(s)`;
    } else if (hasWarnings) {
      status = 'VALID_WITH_WARNINGS';
      const warningCount = errors.filter(e => e.severity === 'WARNING').length;
      message = `Validation passed with ${warningCount} warning(s)`;
    }

    LOG.info(`Validation for invoice ${headerId}: ${status}`, { 
      errorCount: errors.filter(e => e.severity === 'ERROR').length,
      warningCount: errors.filter(e => e.severity === 'WARNING').length
    });

    return {
      isValid: !hasErrors,
      status,
      message,
      errors
    };
  });

  // ============================================
  // RECORD APPROVAL
  // ============================================
  srv.on('RecordApproval', async (req) => {
    const { headerId, approved, approver, comments } = req.data;
    
    if (!headerId || approved === undefined || !approver) {
      req.error(400, 'headerId, approved, and approver are required');
      return;
    }

    const tx = cds.tx(req);

    const header = await tx.read(InvoiceHeader, headerId, ['ID', 'status']);
    
    if (!header) {
      req.error(404, `Invoice ${headerId} not found`);
      return;
    }

    const updateData = {
      approvalStatus: approved ? 'APPROVED' : 'REJECTED',
      approvedBy: approver,
      approvedAt: new Date(),
      step: approved ? 'APPROVED' : 'REJECTED',
      status: approved ? 'COMPLETED' : 'ERROR',
      result: approved ? 'SUCCESS' : 'FAILURE',
      message: approved 
        ? `Approved by ${approver}` 
        : `Rejected by ${approver}: ${comments || 'No reason provided'}`
    };

    if (!approved) {
      updateData.rejectionReason = comments || 'Rejected by approver';
    }

    await tx.update(InvoiceHeader, headerId).set(updateData);

    await logProcess(tx, headerId, 
      approved ? 'APPROVED' : 'REJECTED', 
      approved ? 'COMPLETED' : 'REJECTED',
      approved ? 'SUCCESS' : 'FAILURE',
      comments || `${approved ? 'Approved' : 'Rejected'} by ${approver}`,
      { approver, approved }
    );

    LOG.info(`Invoice ${headerId} ${approved ? 'approved' : 'rejected'} by ${approver}`);

    return {
      status: approved ? 'APPROVED' : 'REJECTED',
      message: `Invoice ${approved ? 'approved' : 'rejected'} successfully`
    };
  });

  // ============================================
  // GET INVOICE STATUS (for BPA polling)
  // ============================================
  srv.on('GetInvoiceStatus', async (req) => {
    const { headerId } = req.data;
    
    if (!headerId) {
      req.error(400, 'headerId is required');
      return;
    }

    const tx = cds.tx(req);

    const header = await tx.read(InvoiceHeader, headerId, [
      'ID', 'step', 'status', 'result', 'message',
      'matchedSupplierNumber', 'poMatchStatus', 
      'approvalStatus', 'accountingDocument'
    ]);

    if (!header) {
      req.error(404, `Invoice ${headerId} not found`);
      return;
    }

    return {
      headerId: header.ID,
      step: header.step,
      status: header.status,
      result: header.result,
      message: header.message,
      supplierMatched: !!header.matchedSupplierNumber,
      poMatched: header.poMatchStatus === 'MATCHED',
      approved: header.approvalStatus === 'APPROVED',
      posted: !!header.accountingDocument
    };
  });
};