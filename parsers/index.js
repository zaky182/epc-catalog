const { ingestKomatsuPdf } = require('./komatsu');
const { ingestCsvCatalog, CSV_TEMPLATE } = require('./generic-csv');

/**
 * Multi-brand parser adapter router.
 * New brand adapters (volvo.js, cat.js, hitachi.js) can be registered here seamlessly.
 */
async function ingestPdfByAdapter({ parserType = 'komatsu', pdfPath, bookId, onProgress }) {
  switch ((parserType || 'komatsu').toLowerCase()) {
    case 'komatsu':
    default:
      return ingestKomatsuPdf({ pdfPath, bookId, onProgress });
  }
}

module.exports = {
  ingestPdfByAdapter,
  ingestCsvCatalog,
  CSV_TEMPLATE
};
