import React, { useRef } from 'react'

function CSVUpload({ onFileUpload }) {
  const fileInputRef = useRef(null)

  const handleFileChange = (event) => {
    const file = event.target.files[0]
    if (file) {
      if (!file.name.endsWith('.csv')) {
        alert('Please upload a CSV file')
        return
      }
      onFileUpload(file)
    }
  }

  const handleClick = () => {
    fileInputRef.current.click()
  }

  return (
    <div className="upload-section">
      <h2>Upload Robinhood Trades</h2>
      <p>Select your Robinhood CSV export file</p>
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv"
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />
      <button onClick={handleClick}>
        Choose CSV File
      </button>
    </div>
  )
}

export default CSVUpload
