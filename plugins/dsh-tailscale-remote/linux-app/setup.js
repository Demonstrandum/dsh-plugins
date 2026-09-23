document.querySelector('form').addEventListener('submit', async event => {
  event.preventDefault()
  const button = document.querySelector('button')
  button.disabled = true
  try {
    document.querySelector('#error').textContent = await window.dsh.connect(document.querySelector('#url').value) || ''
  } catch (error) { document.querySelector('#error').textContent = error.message }
  finally { button.disabled = false }
})
