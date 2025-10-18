// srv/handlers/sap-posting.js
const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const { formatDateForSAP, logProcess, parseJSON } = require('../utils/helpers');

module.exports = function(srv) {
  const LOG = cds.log('sap-posting');
  const { InvoiceHeader, DOXInvoiceItem } = srv.entities;

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

    LOG.info(`Posting invoice ${headerId} to SAP (type: ${postingType})`);

    try {
      // Get invoice header with items
      const header = await tx.read(InvoiceHeader, headerId, h => {
        h('*'),
        h.doxItems('*')
      });

      if (!header) {
        req.error(404, `Invoice ${headerId} not found`);
        return;
      }

      // Validate invoice is ready for posting
      if (!header.matchedSupplierNumber) {
        req.error(400, 'Invoice supplier not matched');
        return;
      }

      if (!header.netAmount || header.netAmount <= 0) {
        req.error(400, 'Invalid invoice amount');
        return;
      }

      LOG.info(`Posting invoice: Supplier ${header.matchedSupplierNumber}, Amount ${header.netAmount} ${header.currencyCode}`);

      // Build SAP invoice document
      const sapInvoice = buildSAPInvoiceDocument(header);

      // Post to SAP
      const DEST_NAME = process.env.S4_DEST_NAME || 'S4HANA';
      const sapResponse = await postInvoiceToSAP(DEST_NAME, sapInvoice);

      // Process response
      const isSuccess = sapResponse.returnType === 'S';

      if (isSuccess) {
        await tx.update(InvoiceHeader, headerId).set({
          accountingDocument: sapResponse.accountingDocument,
          fiscalYear: sapResponse.fiscalYear,
          accountingDocType: sapResponse.docType,
          sapReturnType: sapResponse.returnType,
          sapReturnMessage: sapResponse.message,
          sapMessageClass: sapResponse.messageClass,
          sapMessageNumber: sapResponse.messageNumber,
          status: 'COMPLETED',
          step: 'POSTED',
          result: 'SUCCESS',
          message: `Posted successfully: ${sapResponse.accountingDocument}`
        });

        await logProcess(tx, headerId, 'SAP_POST', 'POSTED', 'SUCCESS',
          `Document ${sapResponse.accountingDocument} posted successfully`);

        LOG.info(`Invoice ${headerId} posted successfully: ${sapResponse.accountingDocument}`);

        return {
          success: true,
          accountingDocument: sapResponse.accountingDocument,
          fiscalYear: sapResponse.fiscalYear,
          message: sapResponse.message,
          sapResponse: JSON.stringify(sapResponse)
        };

      } else {
        await tx.update(InvoiceHeader, headerId).set({
          sapReturnType: sapResponse.returnType,
          sapReturnMessage: sapResponse.message,
          sapMessageClass: sapResponse.messageClass,
          sapMessageNumber: sapResponse.messageNumber,
          status: 'ERROR',
          step: 'POST_FAILED',
          result: 'FAILURE',
          lastError: sapResponse.message,
          lastErrorAt: new Date()
        });

        await logProcess(tx, headerId, 'SAP_POST', 'FAILED', 'FAILURE',
          `Posting failed: ${sapResponse.message}`);

        LOG.error(`Invoice ${headerId} posting failed: ${sapResponse.message}`);

        req.error(500, `SAP posting failed: ${sapResponse.message}`);
      }

    } catch (error) {
      LOG.error('Posting to SAP failed:', error);

      await tx.update(InvoiceHeader, headerId).set({
        status: 'ERROR',
        step: 'POST_ERROR',
        lastError: error.message,
        lastErrorAt: new Date()
      });

      await logProcess(tx, headerId, 'SAP_POST', 'ERROR', 'FAILURE',
        `Posting error: ${error.message}`);

      req.error(500, `Failed to post invoice: ${error.message}`);
    }
  });

  // ============================================
  // HELPERS
  // ============================================

  function buildSAPInvoiceDocument(header) {
    const documentDate = formatDateForSAP(header.documentDate);
    const postingDate = formatDateForSAP(new Date());

    return {
      CompanyCode: header.companyCode,
      Supplier: header.matchedSupplierNumber,
      DocumentDate: documentDate,
      PostingDate: postingDate,
      InvoiceReference: header.documentNumber,
      DocumentCurrency: header.currencyCode,
      InvoiceGrossAmount: header.grossAmount,
      TaxAmount: header.taxAmount,
      DocumentHeaderText: `Invoice ${header.documentNumber}`,
      
      // Line items
      Items: (header.doxItems || []).map((item, index) => ({
        ItemNumber: String((index + 1) * 10).padStart(6, '0'),
        GLAccount: '0000400000', // Default G/L account
        Amount: item.netAmount,
        TaxCode: item.taxCode || 'V0',
        Quantity: item.quantity,
        UnitOfMeasure: item.unitOfMeasure,
        ItemText: item.description,
        MaterialNumber: item.materialNumber
      }))
    };
  }

  async function postInvoiceToSAP(destName, invoiceData) {
    // This uses the Supplier Invoice API
    // Destination base: https://vhcals4hci.resolvetech.com/sap/opu/odata/sap
    // Append: /API_SUPPLIERINVOICE_PROCESS_SRV/A_SupplierInvoice
    
    const path = '/API_SUPPLIERINVOICE_PROCESS_SRV/A_SupplierInvoice';
    const SAP_CLIENT = process.env.S4_CLIENT || '100';

    try {
      const { data } = await executeHttpRequest(
        { destinationName: destName },
        {
          method: 'POST',
          url: buildUrl(path, { 'sap-client': SAP_CLIENT, $format: 'json' }),
          headers: { 
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          data: invoiceData
        }
      );

      // Parse SAP response
      return {
        returnType: 'S',
        accountingDocument: data?.AccountingDocument || data?.d?.AccountingDocument,
        fiscalYear: data?.FiscalYear || data?.d?.FiscalYear,
        docType: data?.AccountingDocumentType || 'KR',
        message: 'Invoice posted successfully',
        messageClass: '',
        messageNumber: ''
      };

    } catch (error) {
      LOG.error('SAP API call failed:', error);

      // Parse error response
      const errorData = error.response?.data || error;
      const sapError = errorData?.error?.innererror?.errordetails?.[0] || errorData?.error;

      return {
        returnType: 'E',
        accountingDocument: null,
        fiscalYear: null,
        docType: null,
        message: sapError?.message || error.message,
        messageClass: sapError?.code || '',
        messageNumber: ''
      };
    }
  }

  function buildUrl(path, params) {
    const url = new URL('http://dummy' + path);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, value);
      }
    });
    return url.pathname + url.search;
  }
};