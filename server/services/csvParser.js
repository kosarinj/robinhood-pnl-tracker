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

export const parseTrades = (file) => {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        try {
          const trades = results.data.map((row, index) => {
            // Robinhood CSV format:
            // Activity Date, Process Date, Settle Date, Instrument, Description, Trans Code, Quantity, Price, Amount

            const instrument = row['Instrument'] || row['Symbol'] || ''
            const description = row['Description'] || ''

            // Determine if it's an option - check description for "Put" or "Call"
            const descLower = description.toLowerCase()
            const isOption = descLower.includes('put') || descLower.includes('call')

            // For options, use the full description as the symbol
            // For stocks, use the instrument (ticker symbol)
            let symbol = isOption ? description : instrument.trim()


            // Parse quantity, price, and amount with currency cleaning
            let quantity = parseCurrency(row['Quantity'] || row['Qty'] || 0)
            let price = parseCurrency(row['Price'] || row['Trade Price'] || 0)
            const amount = parseCurrency(row['Amount'] || 0)

            // For options: use the Amount field directly (already correct contract value)
            // Set quantity=1 and price=amount so that quantity*price=amount in calculations
            if (isOption) {
              quantity = 1
              price = amount
            }

            // Determine if buy or sell
            // Trans codes: Buy, Sell, BTO (Buy to Open), BTC (Buy to Close), STO (Sell to Open), STC (Sell to Close)
            const transCode = (row['Trans Code'] || row['Type'] || '').toUpperCase()
            const isBuy = transCode.includes('BUY') || transCode === 'BTO' || transCode === 'BTC'

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
              transCode,
              rawRow: row
            }
          })

          // Separate trades from dividends/interest
          const validTrades = trades
            .filter(t => {
              const tc = t.transCode
              // Exclude dividends and interest from trades
              if (tc === 'CDIV' || tc === 'MDIV' || tc === 'INT' || tc === 'MINT') {
                return false
              }
              return t.symbol && t.quantity > 0 && t.price > 0
            })
            .sort((a, b) => a.date - b.date)

          // Extract dividends and interest
          const dividendsAndInterest = results.data
            .map((row, index) => {
              const transCode = (row['Trans Code'] || '').toUpperCase()
              if (!['CDIV', 'MDIV', 'INT', 'MINT'].includes(transCode)) {
                return null
              }

              const instrument = row['Instrument'] || row['Symbol'] || ''
              const amount = parseCurrency(row['Amount'] || 0)
              const dateStr = row['Activity Date'] || row['Date'] || row['Trade Date']
              const date = new Date(dateStr)

              return {
                id: index,
                date,
                symbol: instrument.trim(),
                amount: Math.abs(amount),
                transCode,
                isDividend: transCode === 'CDIV' || transCode === 'MDIV',
                isInterest: transCode === 'INT' || transCode === 'MINT',
                description: row['Description'] || ''
              }
            })
            .filter(item => item !== null)
            .sort((a, b) => a.date - b.date)

          // Count options for debugging
          const optionCount = validTrades.filter(t => t.isOption).length
          const stockCount = validTrades.filter(t => !t.isOption).length
          console.log(`📊 CSV Parsed: ${stockCount} stock trades, ${optionCount} option trades, ${dividendsAndInterest.length} dividends/interest`)

          if (validTrades.length === 0) {
            reject(new Error('No valid trades found in CSV. Please check the file format.'))
          } else {
            resolve({
              trades: validTrades,
              dividendsAndInterest: dividendsAndInterest
            })
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

// Parse ACH deposits from CSV to calculate total principal
export const parseDeposits = (file) => {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
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
