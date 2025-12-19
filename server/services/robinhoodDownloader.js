import puppeteer from 'puppeteer'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export const downloadRobinhoodReport = async () => {
  console.log('🤖 Starting Robinhood download automation...')

  let browser
  try {
    // Set up download directory
    const downloadPath = path.join(__dirname, '..', 'downloads')
    if (!fs.existsSync(downloadPath)) {
      fs.mkdirSync(downloadPath, { recursive: true })
    }

    // Launch browser with download preferences
    browser = await puppeteer.launch({
      headless: false, // Show browser so user can log in
      defaultViewport: null,
      args: ['--start-maximized']
    })

    const page = await browser.newPage()

    // Set up download behavior
    const client = await page.target().createCDPSession()
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadPath
    })

    console.log('📱 Opening Robinhood login page...')
    await page.goto('https://robinhood.com/login', { waitUntil: 'networkidle2' })

    // Wait for user to log in
    console.log('⏳ Waiting for you to log in...')
    console.log('   Please log in to Robinhood in the browser window')

    // Wait for navigation to account page (indicates successful login)
    await page.waitForNavigation({
      waitUntil: 'networkidle2',
      timeout: 300000 // 5 minutes for user to log in
    })

    console.log('✅ Login detected! Navigating to documents...')

    // Navigate to account documents page
    await page.goto('https://robinhood.com/account/documents', { waitUntil: 'networkidle2' })

    // Wait a bit for the page to fully load
    await page.waitForTimeout(2000)

    console.log('📄 Looking for account statements...')

    // Click on "Account Statements" or similar section
    // This is a placeholder - we'll need to adjust selectors based on actual Robinhood page structure
    try {
      // Try to find and click the account statements section
      await page.waitForSelector('a[href*="statements"], button:has-text("Account Statements")', { timeout: 10000 })
      await page.click('a[href*="statements"], button:has-text("Account Statements")')
      await page.waitForTimeout(2000)
    } catch (error) {
      console.log('⚠️  Could not find account statements link, continuing...')
    }

    // Look for download button/link for the most recent statement
    console.log('⬇️  Attempting to download activity report...')

    // This is a placeholder - actual selector will depend on Robinhood's HTML structure
    // We might need to click "Download" or "Export CSV" button
    const downloadSelector = 'button:has-text("Download"), a:has-text("Download CSV"), button[aria-label*="Download"]'

    try {
      await page.waitForSelector(downloadSelector, { timeout: 10000 })
      await page.click(downloadSelector)

      // Wait for download to complete
      console.log('⏳ Waiting for download to complete...')
      await page.waitForTimeout(5000)

      // Check if file was downloaded
      const files = fs.readdirSync(downloadPath)
      const csvFiles = files.filter(f => f.endsWith('.csv'))

      if (csvFiles.length > 0) {
        // Get the most recent CSV file
        const latestFile = csvFiles
          .map(f => ({ name: f, time: fs.statSync(path.join(downloadPath, f)).mtime }))
          .sort((a, b) => b.time - a.time)[0].name

        const filePath = path.join(downloadPath, latestFile)
        console.log(`✅ Downloaded: ${latestFile}`)

        await browser.close()

        return {
          success: true,
          filePath: filePath,
          fileName: latestFile
        }
      } else {
        throw new Error('No CSV file found in downloads')
      }
    } catch (error) {
      console.error('❌ Could not find or click download button:', error.message)

      // Keep browser open so user can manually download
      console.log('🖱️  Please manually download the CSV file from the browser window')
      console.log('   The browser will stay open for 2 minutes...')

      await page.waitForTimeout(120000) // Wait 2 minutes

      // Check again for downloaded files
      const files = fs.readdirSync(downloadPath)
      const csvFiles = files.filter(f => f.endsWith('.csv'))

      if (csvFiles.length > 0) {
        const latestFile = csvFiles
          .map(f => ({ name: f, time: fs.statSync(path.join(downloadPath, f)).mtime }))
          .sort((a, b) => b.time - a.time)[0].name

        const filePath = path.join(downloadPath, latestFile)
        console.log(`✅ Found downloaded file: ${latestFile}`)

        await browser.close()

        return {
          success: true,
          filePath: filePath,
          fileName: latestFile,
          manualDownload: true
        }
      }

      await browser.close()
      throw new Error('No CSV file was downloaded')
    }
  } catch (error) {
    console.error('❌ Error during Robinhood download:', error)
    if (browser) {
      await browser.close()
    }
    throw error
  }
}
