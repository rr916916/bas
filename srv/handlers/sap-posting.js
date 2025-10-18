// srv/handlers/sap-posting.js
const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const { 
  parseJSON, 
  logProcess, 
  truncate, 
  formatDateForSAPOData,
  extractSAPError,
  buildUrl
} = require('../utils/helpers');

module.exports = function(srv) {
  const LOG = cds.log('sap-posting');
  const { InvoiceHeader, DOXInvoiceItem, SAPPOItem } = srv.entities;

  // ============================================
  // POST TO SAP
  // ============================================
  srv.on('PostToSAP', async (req) => {
    const { headerId, postingType = 'SUPPLIER_INVOICE' } = req.data;

    if (!headerId) {
      req.error(400, 'headerId is required');
      return;
    }

    const tx = cds.tx(req);

    // Get invoice with all related data
    const header = await tx.read(InvoiceHeader, headerId, h => {
      h('*'),
      h.doxItems(di => di('*')),
      h.poItems(pi => pi('*'))
    });

    if (!header) {
      req.error(404, `Invoice ${headerId} not found`);
      return;
    }

    LOG.info(`Posting invoice ${headerId} to SAP as ${postingType}`);

    const DEST_NAME = process.env.S4_DEST_NAME || 'S4HANA';
    const SYSTEM_KIND = process.env.S4_KIND || 'onprem';

    try {
      let sapResponse;

      if (postingType === 'SUPPLIER_INVOICE') {
        sapResponse = await postSupplierInvoice(header, DEST_NAME, SYSTEM_KIND);
      } else if (postingType === 'ACCOUNTING_DOC') {
        sapResponse = await postAccountingDocument(header, DEST_NAME, SYSTEM_KIND);
      } else {
        req.error(400, `Invalid posting type: ${postingType}`);
        return;
      }

      const success = sapResponse.type === 'S';

      // Update header - truncate long values to fit schema
      await tx.update(InvoiceHeader, headerId).set({
        accountingDocument: sapResponse.document,
        fiscalYear: sapResponse.fiscalYear,
        accountingDocType: sapResponse.docType,
        sapReturnType: sapResponse.type,
        sapReturnMessage: truncate(sapResponse.message, 255),
        sapMessageClass: truncate(sapResponse.messageClass, 50),
        sapMessageNumber: truncate(sapResponse.messageNumber, 10),
        step: success ? 'POSTED' : 'POST_FAILED',
        status: success ? 'COMPLETED' : 'ERROR',
        result: success ? 'SUCCESS' : 'FAILURE',
        postingDate: success ? new Date().toISOString().split('T')[0] : null
      });

      await logProcess(tx, headerId, 'SAP_POST', 
        success ? 'POSTED' : 'FAILED',
        success ? 'SUCCESS' : 'FAILURE',
        sapResponse.message,
        { sapResponse: sapResponse.fullResponse }
      );

      LOG.info(`Invoice ${headerId} posting ${success ? 'succeeded' : 'failed'}: ${sapResponse.message}`);

      return {
        success,
        accountingDocument: sapResponse.document,
        fiscalYear: sapResponse.fiscalYear,
        message: sapResponse.message,
        sapResponse: JSON.stringify(sapResponse.fullResponse)
      };

    } catch (error) {
      LOG.error('SAP posting failed:', error);

      await tx.update(InvoiceHeader, headerId).set({
        step: 'POST_ERROR',
        status: 'ERROR',
        result: 'FAILURE',
        lastError: truncate(error.message, 500),
        lastErrorAt: new Date(),
        retryCount: (header.retryCount || 0) + 1
      });

      await logProcess(tx, headerId, 'SAP_POST', 'ERROR', 'FAILURE',
        error.message);

      req.error(500, `SAP posting failed: ${error.message}`);
    }
  });

  // ============================================
  // RECORD POSTING RESULT
  // ============================================
  srv.on('RecordPostingResult', async (req) => {
    const { data } = req.data;
    const payload = parseJSON(data);

    if (!payload || !payload.headerId) {
      req.error(400, 'Invalid data: headerId is required');
      return;
    }

    const tx = cds.tx(req);
    const isSuccess = payload.sapReturnType === 'S';

    await tx.update(InvoiceHeader, payload.headerId).set({
      accountingDocument: payload.accountingDocument,
      fiscalYear: payload.fiscalYear,
      accountingDocType: payload.accountingDocType,
      sapReturnType: payload.sapReturnType,
      sapReturnMessage: truncate(payload.sapReturnMessage, 255),
      sapMessageClass: truncate(payload.sapMessageClass, 50),
      sapMessageNumber: truncate(payload.sapMessageNumber, 10),
      clearingDate: payload.clearingDate,
      status: isSuccess ? 'COMPLETED' : 'ERROR',
      step: isSuccess ? 'POSTED' : 'POST_FAILED',
      result: isSuccess ? 'SUCCESS' : 'FAILURE'
    });

    await logProcess(tx, payload.headerId, 'SAP_POST',
      isSuccess ? 'POSTED' : 'FAILED',
      isSuccess ? 'SUCCESS' : 'FAILURE',
      payload.sapReturnMessage
    );

    LOG.info(`Posting result recorded for invoice ${payload.headerId}: ${isSuccess ? 'SUCCESS' : 'FAILURE'}`);

    return {
      status: isSuccess ? 'SUCCESS' : 'FAILURE',
      message: payload.sapReturnMessage
    };
  });

  // ============================================
  // POST SUPPLIER INVOICE
  // ============================================
  async function postSupplierInvoice(header, destName, systemKind) {
    LOG.info(`Posting supplier invoice to SAP (${systemKind})`);

    const payload = buildSupplierInvoicePayload(header);
    LOG.info('Posting payload:', JSON.stringify(payload, null, 2));

    // Destination base: https://vhcals4hci.resolvetech.com/sap/opu/odata/sap
    // Path: /API_SUPPLIERINVOICE_PROCESS_SRV/A_SupplierInvoice
    const path = '/API_SUPPLIERINVOICE_PROCESS_SRV/A_SupplierInvoice';
    const client = process.env.S4_CLIENT || '100';

    try {
      // ✅ FIXED: Only sap-client for POST requests, NO $format or other query options
      const { data } = await executeHttpRequest(
        { destinationName: destName },
        {
          method: 'POST',
          url: buildUrl(path, { 'sap-client': client }),
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          data: payload
        }
      );

      // Handle OData v2 response (wrapped in 'd')
      const result = data?.d || data;
      LOG.info('SAP Response:', JSON.stringify(result, null, 2));

      return {
        type: 'S',
        document: result.SupplierInvoice,
        fiscalYear: result.FiscalYear,
        docType: 'RE',
        message: `Supplier invoice ${result.SupplierInvoice} created successfully`,
        messageClass: '',
        messageNumber: '',
        fullResponse: data
      };

    } catch (error) {
      LOG.error('SAP API Error:', {
        message: error.message,
        response: error.response?.data,
        status: error.response?.status
      });

      const sapError = extractSAPError(error);
      throw new Error(`SAP posting failed: ${sapError}`);
    }
  }

  // ============================================
  // POST ACCOUNTING DOCUMENT
  // ============================================
  async function postAccountingDocument(header, destName, systemKind) {
    LOG.info(`Posting accounting document to SAP (${systemKind})`);

    const payload = buildAccountingDocPayload(header);
    const path = '/API_JOURNALENTRY_SRV/A_JournalEntryBulkCreateRequest';
    const client = process.env.S4_CLIENT || '100';

    try {
      // ✅ FIXED: Only sap-client for POST requests, NO $format or other query options
      const { data } = await executeHttpRequest(
        { destinationName: destName },
        {
          method: 'POST',
          url: buildUrl(path, { 'sap-client': client }),
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          data: payload
        }
      );

      return {
        type: 'S',
        document: data.AccountingDocument || data.d?.AccountingDocument,
        fiscalYear: data.FiscalYear || data.d?.FiscalYear,
        docType: 'KR',
        message: `Accounting document created successfully`,
        messageClass: '',
        messageNumber: '',
        fullResponse: data
      };

    } catch (error) {
      LOG.error('SAP API Error:', error);
      const sapError = extractSAPError(error);
      throw new Error(`Accounting document posting failed: ${sapError}`);
    }
  }

  // ============================================
  // BUILD SUPPLIER INVOICE PAYLOAD
  // Verified against API_SUPPLIERINVOICE_PROCESS_SRV metadata
  // ============================================
  function buildSupplierInvoicePayload(header) {
    const items = [];

    // Build line items from matched DOX items
    for (const doxItem of header.doxItems || []) {
      if (doxItem.matchStatus !== 'MATCHED' || !doxItem.matchedPOItem_ID) {
        continue;
      }

      const poItem = (header.poItems || []).find(pi => pi.ID === doxItem.matchedPOItem_ID);
      if (!poItem) continue;

      items.push({
        SupplierInvoiceItem: String(items.length + 1).padStart(4, '0'),
        PurchaseOrder: poItem.PurchaseOrder,
        PurchaseOrderItem: poItem.PurchaseOrderItem,
        Plant: poItem.Plant || '',
        TaxCode: doxItem.taxCode || poItem.TaxCode || '',
        DocumentCurrency: header.currencyCode,
        SupplierInvoiceItemAmount: String(doxItem.netAmount),
        QuantityInPurchaseOrderUnit: String(doxItem.quantity),
        // ✅ CRITICAL FIX: Always use PO's unit, never invoice's unit
        PurchaseOrderQuantityUnit: poItem.OrderUnit || ''
      });
    }

    // Format dates in OData v2 format: /Date(timestamp)/
    const documentDate = formatDateForSAPOData(header.documentDate);
    const postingDate = formatDateForSAPOData(new Date());
    const dueDate = formatDateForSAPOData(header.dueDate || header.documentDate);

    // Build payload according to API_SUPPLIERINVOICE_PROCESS_SRV metadata
    return {
      CompanyCode: header.companyCode,
      DocumentDate: documentDate,
      PostingDate: postingDate,
      InvoicingParty: header.matchedSupplierNumber,
      DocumentCurrency: header.currencyCode,
      InvoiceGrossAmount: String(header.grossAmount),
      DueCalculationBaseDate: dueDate,
      // PaymentTerms removed - SAP will use supplier's default payment terms
      DocumentHeaderText: header.documentNumber ? `Invoice ${header.documentNumber}` : 'AUTO',
      SupplierInvoiceIDByInvcgParty: header.documentNumber || '',
      to_SuplrInvcItemPurOrdRef: items
    };
  }

  // ============================================
  // BUILD ACCOUNTING DOCUMENT PAYLOAD
  // ============================================
  function buildAccountingDocPayload(header) {
    const items = [];

    // Vendor line (credit)
    items.push({
      GLAccount: '',
      AccountingDocumentItem: '001',
      AccountingDocumentItemType: 'K',
      Supplier: header.matchedSupplierNumber,
      AmountInTransactionCurrency: header.grossAmount,
      DebitCreditCode: 'H',
      DocumentItemText: header.documentNumber ? `Invoice ${header.documentNumber}` : 'AUTO'
    });

    // Expense lines (debit)
    let itemNum = 2;
    for (const doxItem of header.doxItems || []) {
      items.push({
        GLAccount: '400000', // Default expense account
        AccountingDocumentItem: String(itemNum).padStart(3, '0'),
        AmountInTransactionCurrency: doxItem.netAmount,
        DebitCreditCode: 'S',
        TaxCode: doxItem.taxCode || '',
        DocumentItemText: truncate(doxItem.description || 'Invoice Item', 50)
      });
      itemNum++;
    }

    // Tax line
    if (header.taxAmount && header.taxAmount > 0) {
      items.push({
        GLAccount: '154000', // Default tax account
        AccountingDocumentItem: String(itemNum).padStart(3, '0'),
        AmountInTransactionCurrency: header.taxAmount,
        DebitCreditCode: 'S',
        TaxCode: header.doxItems?.[0]?.taxCode || '',
        DocumentItemText: 'Tax'
      });
    }

    return {
      MessageHeader: {
        CreationDateTime: new Date().toISOString()
      },
      JournalEntry: {
        CompanyCode: header.companyCode,
        DocumentDate: header.documentDate,
        PostingDate: new Date().toISOString().split('T')[0],
        DocumentHeaderText: header.documentNumber ? `Invoice ${header.documentNumber}` : 'AUTO',
        DocumentReferenceID: header.documentNumber || '',
        Items: items
      }
    };
  }
};