// srv/handlers/invoice.js
// Basic invoice operations and legacy BPA actions
const cds = require('@sap/cds');
const { parseJSON, logProcess } = require('../utils/helpers');

module.exports = function(srv) {
  const LOG = cds.log('invoice');
  const { InvoiceHeader, DOXInvoiceItem } = srv.entities;

  // ============================================
  // CREATE INVOICE FROM DOX (Legacy - CPI calls this)
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
        
        // Company code
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
  // RECORD APPROVAL (Legacy - kept for backward compatibility)
  // ============================================
  srv.on('RecordApproval', async (req) => {
    // BPA sends as flat key-value pairs
    const headerId = req.data.headerId;
    const approved = req.data.approved;
    const approver = req.data.approver;
    const comments = req.data.comments;
    
    if (!headerId || approved === undefined || !approver) {
      req.error(400, 'headerId, approved, and approver are required');
      return;
    }

    const tx = cds.tx(req);

    try {
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
        message: `Invoice ${approved ? 'approved' : 'rejected'} successfully`,
        nextStep: approved ? 'POST_TO_SAP' : 'COMPLETE'
      };

    } catch (error) {
      LOG.error('Record approval failed:', error);
      req.error(500, `Failed to record approval: ${error.message}`);
    }
  });

  // ============================================
  // GET INVOICE STATUS (For BPA polling)
  // ============================================
  srv.on('GetInvoiceStatus', async (req) => {
    // BPA sends as flat key-value pairs
    const headerId = req.data.headerId;
    
    if (!headerId) {
      req.error(400, 'headerId is required');
      return;
    }

    const tx = cds.tx(req);

    try {
      const header = await tx.read(InvoiceHeader, headerId, [
        'ID', 'step', 'status', 'result', 'message',
        'matchedSupplierNumber', 'poMatchStatus', 
        'approvalStatus', 'accountingDocument',
        'threeWayMatchStatus'
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
        validated: header.step === 'VALIDATED' || header.step === 'APPROVED',
        approved: header.approvalStatus === 'APPROVED',
        posted: !!header.accountingDocument,
        accountingDocument: header.accountingDocument
      };

    } catch (error) {
      LOG.error('Get invoice status failed:', error);
      req.error(500, `Failed to get status: ${error.message}`);
    }
  });

  // ============================================
  // RECORD POSTING RESULT (Called by SAP posting handler)
  // ============================================
  srv.on('RecordPostingResult', async (req) => {
    const { data } = req.data;
    const payload = parseJSON(data);

    if (!payload) {
      req.error(400, 'Invalid JSON data');
      return;
    }

    const {
      headerId,
      accountingDocument,
      fiscalYear,
      accountingDocType,
      sapReturnType,
      sapReturnMessage,
      sapMessageClass,
      sapMessageNumber,
      clearingDate
    } = payload;

    if (!headerId) {
      req.error(400, 'headerId is required');
      return;
    }

    const tx = cds.tx(req);

    try {
      const isSuccess = sapReturnType === 'S';

      await tx.update(InvoiceHeader, headerId).set({
        accountingDocument,
        fiscalYear,
        accountingDocType,
        sapReturnType,
        sapReturnMessage,
        sapMessageClass,
        sapMessageNumber,
        clearingDate,
        status: isSuccess ? 'COMPLETED' : 'ERROR',
        step: isSuccess ? 'POSTED' : 'POST_FAILED',
        result: isSuccess ? 'SUCCESS' : 'FAILURE'
      });

      await logProcess(tx, headerId, 'SAP_POST',
        isSuccess ? 'POSTED' : 'FAILED',
        isSuccess ? 'SUCCESS' : 'FAILURE',
        sapReturnMessage
      );

      LOG.info(`Posting result recorded for invoice ${headerId}: ${isSuccess ? 'SUCCESS' : 'FAILURE'}`);

      return {
        status: isSuccess ? 'SUCCESS' : 'FAILURE',
        message: sapReturnMessage
      };

    } catch (error) {
      LOG.error('Record posting result failed:', error);
      req.error(500, `Failed to record result: ${error.message}`);
    }
  });
};