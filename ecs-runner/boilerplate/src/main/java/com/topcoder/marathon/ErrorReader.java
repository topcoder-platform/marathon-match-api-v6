package com.topcoder.marathon;

import java.io.BufferedWriter;
import java.io.InputStream;

class ErrorReader extends Thread {
    private final InputStream errorStream;
    private final BufferedWriter errorWriter;
    private final StringBuilder sb = new StringBuilder();
    private final boolean printMessages;
    private static final int maxLength = 10_000_000;

    public ErrorReader(InputStream errorStream, boolean printMessages, BufferedWriter errorWriter) {
        this.errorStream = errorStream;
        this.printMessages = printMessages;
        this.errorWriter = errorWriter;
    }

    public void run() {
        StringBuilder buffer = new StringBuilder();
        try {
            byte[] ch = new byte[65536];
            int read;
            while ((read = errorStream.read(ch)) > 0) {
                String s = new String(ch, 0, read);
                buffer.append(s);
                if (errorStream.available() == 0) {
                    write(buffer.toString());
                    buffer.delete(0, buffer.length());
                }
            }
        } catch (Exception e) {
        }
        try {
            if (buffer.length() > 0) write(buffer.toString());
        } catch (Exception e) {
        }
    }

    private void write(String s) throws Exception {
        if (sb.length() < maxLength) sb.append(s);
        if (printMessages) {
            System.out.print(s);
            System.out.flush();
        }
        if (errorWriter != null) {
            errorWriter.write(s);
            errorWriter.flush();
        }
    }

    public String getOutput() {
        return sb.toString();
    }

    /**
     * Waits for stderr consumption to finish before closing the backing artifact writer.
     *
     * @param timeoutMillis Maximum time to wait for natural stream EOF before forcing the
     *                      stream closed. Values less than or equal to zero skip the wait.
     */
    public void closeAndWait(long timeoutMillis) {
        waitForReader(timeoutMillis);
        if (isAlive()) {
            closeStream();
            waitForReader(100);
        }
        closeWriter();
    }

    public void close() {
        closeAndWait(100);
    }

    /**
     * Joins the reader thread for a bounded drain interval.
     *
     * @param timeoutMillis Maximum join wait time in milliseconds.
     */
    private void waitForReader(long timeoutMillis) {
        if (!isAlive() || Thread.currentThread() == this || timeoutMillis <= 0) {
            return;
        }

        try {
            join(timeoutMillis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /**
     * Closes the stderr stream to unblock the reader thread when natural EOF does not arrive.
     */
    private void closeStream() {
        try {
            if (errorStream != null) errorStream.close();
        } catch (Exception e) {
        }
    }

    /**
     * Closes the optional stderr artifact writer after the reader has drained.
     */
    private void closeWriter() {
        try {
            if (errorWriter != null) errorWriter.close();
        } catch (Exception e) {
        }
    }
}
