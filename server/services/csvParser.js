import Papa from 'papaparse'

// Helper function to clean and parse currency values
const parseCurrency = (value) => {
  if (!value) return 0
  // Remove dollar signs, commas, and handle parentheses for negative values
  const cleaned = value.toString().replace(/[$,]/g, '')
  const isNegative = cleaned.includes('(') && cleaned.includes(')')
  const number = parseFloat(cleaned.replace(/[()]/g, ''))
  return isNegative ? -number : number
}

// Parse trades from CSV string (server version)
export const parseTrades = (csvContent) => {
  return new Promise((resolve, reject) => {
    Papa.parse(csvContent, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        try {
          const trades = results.data.map((row, index) => {
            const instrument = row['Instrument'] || row['Symbol'] || ''
            const description = row['Description'] || ''

            // Determine if it's an option
            const descLower = description.toLowerCase()
            const isOption = descLower.includes('put') || descLower.includes('call')

            // For options, use the full description as the symbol
            // For stocks, use the instrument (ticker symbol)
            let symbol = isOption ? description : instrument.trim()

            // Parse quantity, price, and amount with currency cleaning
            const quantity = parseCurrency(row['Quantity'] || row['Qty'] || 0)
            const price = parseCurrency(row['Price'] || row['Trade Price'] || 0)
            const amount = parseCurrency(row['Amount'] || 0)

            // Determine if buy or sell
            const transCode = (row['Trans Code'] || row['Type'] || '').toUpperCase()
            const isBuy = transCode.includes('BUY') || transCode === 'BTO'

            // Parse date
            const dateStr = row['Activity Date'] || row['Date'] || row['Trade Date']
            const date = new Date(dateStr)

            return {
              id: index,
              date,
              symbol,
              instrument: isOption ? description : instrument,
              description,
              isOption,
              isBuy,
              quantity: Math.abs(quantity),
              price: Math.abs(price),
              amount: Math.abs(amount),
              transCode
            }
          })

          // Filter out invalid trades and sort by date
          const validTrades = trades
            .filter(t => t.symbol && t.quantity > 0 && t.price > 0)
            .sort((a, b) => a.date - b.date)

          if (validTrades.length === 0) {
            reject(new Error('No valid trades found in CSV. Please check the file format.'))
          } else {
            resolve(validTrades)
          }
        } catch (error) {
          reject(new Error(`Error parsing CSV: ${error.message}`))
        }
      },
      error: (error) => {
        reject(new Error(`CSV parsing error: ${error.message}`))
      }
    })
  })
}

// Parse ACH deposits from CSV string (server version)
export const parseDeposits = (csvContent) => {
  return new Promise((resolve, reject) => {
    Papa.parse(csvContent, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        try {
          const deposits = results.data
            .filter(row => {
              const description = (row['Description'] || '').toLowerCase()
              return description.includes('ach deposit')
            })
            .map(row => {
              const amount = parseCurrency(row['Amount'] || 0)
              const dateStr = row['Activity Date'] || row['Date'] || row['Trade Date']
              const date = new Date(dateStr)

              return {
                date,
                amount: Math.abs(amount),
                description: row['Description']
              }
            })
            .filter(d => d.amount > 0)
            .sort((a, b) => a.date - b.date)

          const totalPrincipal = deposits.reduce((sum, d) => sum + d.amount, 0)

          resolve({
            deposits,
            totalPrincipal
          })
        } catch (error) {
          reject(new Error(`Error parsing deposits: ${error.message}`))
        }
      },
      error: (error) => {
        reject(new Error(`CSV parsing error: ${error.message}`))
      }
    })
  })
}
