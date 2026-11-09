// Community level store screen ('store'). See docs/levels.md.
import { registerScreen } from '../app/router'
import { createStore } from './store'
import './store.css'

registerScreen('store', createStore)
