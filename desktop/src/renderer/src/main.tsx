import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import Popup from './Popup'
import './styles.css'

const isPopup = window.location.hash.includes('popup')
if (isPopup) document.body.classList.add('popup')

const root = createRoot(document.getElementById('root') as HTMLElement)
root.render(<StrictMode>{isPopup ? <Popup /> : <App />}</StrictMode>)
