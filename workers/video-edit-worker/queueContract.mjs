export function videoEditQueueName() {
  return process.env.VIDEO_EDIT_QUEUE_NAME || 'selfcanvas-video-edit';
}

export function videoEditCancelKey(jobId, queueName = videoEditQueueName()) {
  return `${queueName}:cancel:${jobId}`;
}

export function redactVideoEditError(error) {
  return String(error || '')
    .replace(/https?:\/\/[^\s)]+/gi, '[remote-service]')
    .replace(/[a-zA-Z]:[\\/][^\r\n;"'<>]*|\/(?:[^\s;"'<>])+/g, '[local-path]')
    .slice(0, 1200);
}
