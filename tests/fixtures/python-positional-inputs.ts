export const positionalSeed = `import os,errno
fd=os.open('position',os.O_CREAT|os.O_RDWR,0o600)
assert os.write(fd,b'abcdefgh')==8
alias=os.dup(fd)
assert os.lseek(alias,3,os.SEEK_SET)==3
assert os.pread(fd,3,1)==b'bcd'
assert os.lseek(alias,0,os.SEEK_CUR)==3
assert os.pwrite(alias,memoryview(b'XYZ'),4)==3
assert os.lseek(fd,0,os.SEEK_CUR)==3
assert os.pread(alias,20,0)==b'abcdXYZh'
assert os.pread(fd,2,100)==b'' and os.pread(fd,0,0)==b''
assert os.pwrite(fd,b'',100)==0 and os.fstat(fd).st_size==8
assert os.pwrite(fd,b'Q',12)==1
assert os.pread(fd,8,8)==b'\\x00'*4+b'Q'
assert os.lseek(alias,0,os.SEEK_CUR)==3
ro=os.open('position',os.O_RDONLY)
wo=os.open('position',os.O_WRONLY)
for operation,code in [(lambda:os.pread(wo,1,0),errno.EBADF),(lambda:os.pwrite(ro,b'!',0),errno.EBADF),(lambda:os.pread(-1,1,0),errno.EBADF),(lambda:os.pwrite(-1,b'!',0),errno.EBADF),(lambda:os.pread(fd,-1,0),errno.EINVAL),(lambda:os.pread(fd,1,-1),errno.EINVAL),(lambda:os.pwrite(fd,b'!',-1),errno.EINVAL),(lambda:os.pwrite(fd,b'',-1),errno.EINVAL)]:
 try:
  operation()
 except OSError as error:
  assert error.errno==code,(error.errno,code)
 else:
  raise AssertionError('invalid positional I/O accepted')
assert os.lseek(alias,0,os.SEEK_CUR)==3
os.close(ro)
os.close(wo)
append=os.open('position',os.O_WRONLY|os.O_APPEND)
os.lseek(append,2,os.SEEK_SET)
assert os.pwrite(append,b'!',0)==1
assert os.lseek(append,0,os.SEEK_CUR)==2
assert os.pread(fd,2,12)==b'Q!'
os.close(append)
os.unlink('position')
with open('position','wb') as replacement:
 replacement.write(b'replacement')
42`;

export const positionalResume = `assert os.fstat(fd).st_nlink==0
assert os.lseek(alias,0,os.SEEK_CUR)==3
assert os.pread(fd,14,0)==b'abcdXYZh'+b'\\x00'*4+b'Q!'
assert os.pwrite(alias,b'12',1)==2
assert os.lseek(fd,0,os.SEEK_CUR)==3
assert os.read(alias,3)==b'dXY'
assert os.lseek(fd,0,os.SEEK_CUR)==6
assert os.pread(fd,4,0)==b'a12d'
with open('position','rb') as replacement:
 assert replacement.read()==b'replacement'
42`;
